/**
 * Base error for all Tierkit-thrown errors. Concrete error subclasses live next to the
 * code that throws them (e.g. PluginLoadError in plugin/PluginLoader, PathTraversalError in
 * fs/safePath) and all extend this class so consumers can catch `TierkitError` to
 * distinguish library-originated failures from unexpected runtime errors.
 */
export class TierkitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TierkitError";
  }
}
