import { Request, Response, NextFunction, RequestHandler } from "express";

// Express does not catch rejected promises thrown inside an `async`
// route handler — an unhandled rejection there crashes the whole Node
// process (confirmed the hard way during this service's own verification
// pass: a query against a not-yet-migrated table took the entire service
// down instead of returning a 500 to that one request). Wrapping every
// async handler with this forwards the error to Express's error-handling
// middleware (see server.ts's final app.use) instead.
export function ah(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
