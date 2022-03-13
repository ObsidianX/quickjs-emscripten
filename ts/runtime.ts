import { EitherModule, QuickJSAsyncEmscriptenModule } from './emscripten-types'
import {
  JSRuntimePointer,
  JSContextPointer,
  JSModuleDefPointer,
  JSContextPointerPointer,
} from './ffi-types'
import {
  Disposable,
  ExecutePendingJobsResult,
  InterruptHandler,
  Lifetime,
  QuickJSHandle,
} from './quickjs'
import {
  QuickJSModuleCallbacks,
  CToHostModuleLoaderImplementation,
  RuntimeCallbacks,
  CToHostInterruptImplementation,
} from './quickjs-module'
import { ContextOptions, DefaultIntrinsics, EitherFFI, JSModuleLoader } from './types'
import { QuickJSContext } from './context'
import { intoPromiseLike, newPromiseLike, unwrapPromiseLike } from './asyncify-helpers'
import { ModuleMemory } from './memory'
import { debug } from './debug'

/**
 * A runtime represents a Javascript runtime corresponding to an object heap.
 * Inside a given runtime, no multi-threading is supported.
 */
export class QuickJSRuntime implements Disposable, RuntimeCallbacks {
  /**
   * If this runtime was created as as part of a context, points to the context
   * associated with the runtime.
   *
   * If this runtime was created stand-alone, this may or may not contain a context.
   * A context here may be allocated if one is needed by the runtime, eg for [[computeMemoryUsage]].
   */
  public context: QuickJSContext | undefined

  /** @private */
  protected module: EitherModule
  /** @private */
  protected memory: ModuleMemory
  /** @private */
  protected ffi: EitherFFI
  /** @private */
  protected rt: Lifetime<JSRuntimePointer>
  /** @private */
  protected callbacks: QuickJSModuleCallbacks

  /** @private */
  protected contextMap = new Map<JSContextPointer, QuickJSContext>()
  /** @private */
  protected moduleLoader: JSModuleLoader | undefined

  constructor(args: {
    module: EitherModule
    ffi: EitherFFI
    rt: Lifetime<JSRuntimePointer>
    callbacks: QuickJSModuleCallbacks
  }) {
    this.module = args.module
    this.memory = new ModuleMemory(this.module)
    this.ffi = args.ffi
    this.rt = args.rt
    this.callbacks = args.callbacks
    this.callbacks.setRuntimeCallbacks(this.rt.value, this)
  }

  get alive() {
    return this.rt.alive
  }

  dispose() {
    return this.rt.dispose()
  }

  newContext(options: ContextOptions = {}): QuickJSContext {
    if (options.intrinsics && options.intrinsics !== DefaultIntrinsics) {
      throw new Error('TODO: Custom intrinsics are not supported yet')
    }

    const ctx = new Lifetime(
      options.contextPointer || this.ffi.QTS_NewContext(this.rt.value),
      undefined,
      ctx_ptr => {
        this.contextMap.delete(ctx_ptr)
        this.callbacks.deleteContext(ctx_ptr)
        this.ffi.QTS_FreeContext(ctx_ptr)
      }
    )

    const context = new QuickJSContext({
      module: this.module,
      ctx,
      ffi: this.ffi,
      rt: this.rt,
      ownedLifetimes: [],
      runtime: this,
      callbacks: this.callbacks,
    })
    this.contextMap.set(ctx.value, context)

    return context
  }

  setModuleLoader(moduleLoader: JSModuleLoader): void {
    this.moduleLoader = moduleLoader
    this.ffi.QTS_RuntimeEnableModuleLoader(this.rt.value)
  }

  removeModuleLoader(): void {
    this.moduleLoader = undefined
    this.ffi.QTS_RuntimeDisableModuleLoader(this.rt.value)
  }

  // Runtime management -------------------------------------------------------

  /**
   * In QuickJS, promises and async functions create pendingJobs. These do not execute
   * immediately and need to be run by calling [[executePendingJobs]].
   *
   * @return true if there is at least one pendingJob queued up.
   */
  hasPendingJob(): boolean {
    return Boolean(this.ffi.QTS_IsJobPending(this.rt.value))
  }

  private interruptHandler: InterruptHandler | undefined

  /**
   * Set a callback which is regularly called by the QuickJS engine when it is
   * executing code. This callback can be used to implement an execution
   * timeout.
   *
   * The interrupt handler can be removed with [[removeInterruptHandler]].
   */
  setInterruptHandler(cb: InterruptHandler) {
    const prevInterruptHandler = this.interruptHandler
    this.interruptHandler = cb
    if (!prevInterruptHandler) {
      this.ffi.QTS_RuntimeEnableInterruptHandler(this.rt.value)
    }
  }

  /**
   * Remove the interrupt handler, if any.
   * See [[setInterruptHandler]].
   */
  removeInterruptHandler() {
    if (this.interruptHandler) {
      this.ffi.QTS_RuntimeDisableInterruptHandler(this.rt.value)
      this.interruptHandler = undefined
    }
  }

  /**
   * Execute pendingJobs on the VM until `maxJobsToExecute` jobs are executed
   * (default all pendingJobs), the queue is exhausted, or the runtime
   * encounters an exception.
   *
   * In QuickJS, promises and async functions create pendingJobs. These do not execute
   * immediately and need to triggered to run.
   *
   * @param maxJobsToExecute - When negative, run all pending jobs. Otherwise execute
   * at most `maxJobsToExecute` before returning.
   *
   * @return On success, the number of executed jobs. On error, the exception
   * that stopped execution. Note that executePendingJobs will not normally return
   * errors thrown inside async functions or rejected promises. Those errors are
   * available by calling [[resolvePromise]] on the promise handle returned by
   * the async function.
   */
  executePendingJobs(maxJobsToExecute: number = -1): ExecutePendingJobsResult {
    const ctxPtrOut = this.memory.newMutablePointerArray<JSContextPointerPointer>(1)
    const valuePtr = this.ffi.QTS_ExecutePendingJob(
      this.rt.value,
      maxJobsToExecute,
      ctxPtrOut.value.ptr
    )

    const ctxPtr = ctxPtrOut.value.typedArray[0] as JSContextPointer
    if (ctxPtr === 0) {
      // No jobs executed.
      this.ffi.QTS_FreeValuePointerRuntime(this.rt.value, valuePtr)
      return { value: 0 }
    }

    const ctx =
      this.contextMap.get(ctxPtr) ??
      this.newContext({
        contextPointer: ctxPtr,
      })

    const resultValue = ctx.getMemory(this.rt.value).heapValueHandle(valuePtr)
    const typeOfRet = ctx.typeof(resultValue)
    if (typeOfRet === 'number') {
      const executedJobs = ctx.getNumber(resultValue)
      resultValue.dispose()
      return { value: executedJobs }
    } else {
      return { error: resultValue }
    }
  }

  /**
   * Set the max memory this runtime can allocate.
   * To remove the limit, set to `-1`.
   */
  setMemoryLimit(limitBytes: number) {
    if (limitBytes < 0 && limitBytes !== -1) {
      throw new Error('Cannot set memory limit to negative number. To unset, pass -1')
    }

    this.ffi.QTS_RuntimeSetMemoryLimit(this.rt.value, limitBytes)
  }

  /**
   * Compute memory usage for this runtime. Returns the result as a handle to a
   * JSValue object. Use [[dump]] to convert to a native object.
   * Calling this method will allocate more memory inside the runtime. The information
   * is accurate as of just before the call to `computeMemoryUsage`.
   * For a human-digestible representation, see [[dumpMemoryUsage]].
   */
  computeMemoryUsage(): QuickJSHandle {
    const serviceContextMemory = this.getSystemContext().getMemory(this.rt.value)
    return serviceContextMemory.heapValueHandle(
      this.ffi.QTS_RuntimeComputeMemoryUsage(this.rt.value, serviceContextMemory.ctx.value)
    )
  }

  /**
   * @hidden
   */
  cToHostInterrupt: CToHostInterruptImplementation = rt => {
    if (rt !== this.rt.value) {
      throw new Error('QuickJSVm instance received C -> JS interrupt with mismatched rt')
    }

    const fn = this.interruptHandler
    if (!fn) {
      throw new Error('QuickJSVm had no interrupt handler')
    }

    return fn(this) ? 1 : 0
  }

  /**
   * @private
   */
  cToHostLoadModule: CToHostModuleLoaderImplementation = (rt, ctx, moduleName) => {
    const moduleLoader = this.moduleLoader
    if (!moduleLoader) {
      throw new Error('Runtime has no module loader')
    }

    if (rt !== this.rt.value) {
      throw new Error('Runtime pointer mismatch')
    }

    const context =
      this.contextMap.get(ctx) ??
      this.newContext({
        contextPointer: ctx,
      })

    const maybeAsync = newPromiseLike(() => moduleLoader(context, moduleName))
      .then(result => {
        if (typeof result === 'object' && 'error' in result && result.error) {
          debug('cToHostLoadModule: loader returned error', result.error)
          throw result.error
        }

        const moduleDef =
          typeof result === 'string' ? result : 'value' in result ? result.value : result

        if (typeof moduleDef === 'string') {
          const compiledModule = context.compileModule(moduleName, moduleDef)
          return compiledModule.value
        }

        // TODO
        throw new Error(`TODO: module definition not implemented.`)
      })
      .catch(error => {
        debug('cToHostLoadModule: caught error', error)
        context.throw(error as any)
        return 0 as JSModuleDefPointer
      })

    return unwrapPromiseLike(maybeAsync)
  }

  private getSystemContext() {
    if (!this.context) {
      this.context = this.newContext()
    }
    return this.context
  }
}
