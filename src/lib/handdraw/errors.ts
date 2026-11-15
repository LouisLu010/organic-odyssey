export type HanddrawErrorCode = 'EMPTY' | 'INVALID_INPUT' | 'LIMIT_EXCEEDED' | 'UNRECOGNIZED'

export class HanddrawRecognitionError extends Error {
  readonly code: HanddrawErrorCode

  constructor(code: HanddrawErrorCode, message: string) {
    super(message)
    this.name = 'HanddrawRecognitionError'
    this.code = code
  }
}
