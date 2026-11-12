import { StaleContext } from './api';
type Job<T> = { current(): boolean; read(): Promise<T>; resolve(value: T): void; reject(error: unknown): void };

// Includes old in-flight bridge requests: switching views cannot exceed the
// concurrency limit by abandoning requests the native bridge cannot abort.
export class RequestQueue<T> {
  private queue: Job<T>[] = [];
  private active = 0;
  private disposed = false;
  constructor(private limit: number) {}
  run(read: Job<T>['read'], current: Job<T>['current']): Promise<T> {
    if (this.disposed || !current()) return Promise.reject(new StaleContext());
    return new Promise((resolve, reject) => { this.queue.push({ read, current, resolve, reject }); this.drain(); });
  }
  private drain() {
    this.queue = this.queue.filter(job => {
      if (!this.disposed && job.current()) return true;
      job.reject(new StaleContext()); return false;
    });
    while (this.active < this.limit && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      Promise.resolve().then(() => {
        if (this.disposed || !job.current()) throw new StaleContext();
        return job.read();
      }).then(value => {
        if (this.disposed || !job.current()) throw new StaleContext();
        job.resolve(value);
      }).catch(job.reject).finally(() => { this.active--; this.drain(); });
    }
  }
  dispose() { this.disposed = true; this.drain(); }
}
