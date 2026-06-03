// A typed error carrying an HTTP status code. Services throw these for expected
// failures (bad input, auth, conflicts); the error middleware turns them into
// JSON responses. Anything that isn't an HttpError is treated as a 500.
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export const badRequest = (message: string): HttpError => new HttpError(400, message);
export const unauthorized = (message = "Unauthorized"): HttpError => new HttpError(401, message);
export const forbidden = (message: string): HttpError => new HttpError(403, message);
export const notFound = (message: string): HttpError => new HttpError(404, message);
export const conflict = (message: string): HttpError => new HttpError(409, message);
