/** A source refused the request or needs configuration; distinguish it from an empty result. */
export class SourceUnavailable extends Error {
  constructor(readonly status: 'refused' | 'unset', note: string) {
    super(note);
    this.name = 'SourceUnavailable';
  }
}
