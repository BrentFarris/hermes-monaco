import { StaleContext } from './api';
import type { ImageSnapshot } from './types';

type Read = { current(): boolean; read(): Promise<ImageSnapshot>; resolve(value: ImageSnapshot): void; reject(error: unknown): void };

// One queue per controller, including requests still finishing after a tab or
// workspace switch. The REST bridge cannot abort an in-flight native request.
export class ImageReads {
  private queue: Read[] = [];
  private active = 0;
  private disposed = false;

  run(read: Read['read'], current: Read['current']): Promise<ImageSnapshot> {
    if (this.disposed || !current()) return Promise.reject(new StaleContext());
    return new Promise((resolve, reject) => {
      this.queue.push({ read, current, resolve, reject });
      this.drain();
    });
  }

  private drain() {
    this.queue = this.queue.filter(job => {
      if (!this.disposed && job.current()) return true;
      job.reject(new StaleContext()); return false;
    });
    while (this.active < 4 && this.queue.length) {
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
