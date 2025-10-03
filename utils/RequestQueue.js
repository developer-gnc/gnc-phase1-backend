class RequestQueue {
    constructor(requestsPerMinute = 10) {
      this.queue = [];
      this.requestsPerMinute = requestsPerMinute;
      this.requestTimes = [];
      this.processing = false;
    }
  
    async add(fn) {
      return new Promise((resolve, reject) => {
        this.queue.push({ fn, resolve, reject });
        if (!this.processing) {
          this.processQueue();
        }
      });
    }
  
    async processQueue() {
      if (this.queue.length === 0) {
        this.processing = false;
        return;
      }
  
      this.processing = true;
      const now = Date.now();
      this.requestTimes = this.requestTimes.filter(time => now - time < 60000);
  
      if (this.requestTimes.length >= this.requestsPerMinute) {
        const oldestRequest = this.requestTimes[0];
        const waitTime = 60000 - (now - oldestRequest) + 1000;
        console.log(`   Rate limit reached. Waiting ${Math.ceil(waitTime/1000)}s...`);
        setTimeout(() => this.processQueue(), waitTime);
        return;
      }
  
      const { fn, resolve, reject } = this.queue.shift();
      this.requestTimes.push(now);
  
      try {
        const result = await fn();
        resolve(result);
      } catch (error) {
        reject(error);
      }
  
      if (this.queue.length > 0) {
        setTimeout(() => this.processQueue(), 100);
      } else {
        this.processing = false;
      }
    }
  }
  
  module.exports = RequestQueue;