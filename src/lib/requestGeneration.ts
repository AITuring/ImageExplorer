/** Identifies the latest asynchronous directory request. */
export class RequestGeneration {
  private generation = 0;

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  /** Invalidate in-flight work after a directory event or effect cleanup. */
  invalidate(): void {
    this.generation += 1;
  }

  isCurrent(requestId: number): boolean {
    return requestId === this.generation;
  }
}
