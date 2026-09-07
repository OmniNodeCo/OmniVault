'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Tiny durable JSON store.
 * - Loads the whole document into memory at startup.
 * - save() writes synchronously via tmp-file + atomic rename, so a request is
 *   only answered after the data is actually on disk (crash-safe ordering).
 *   Synchronous writes also make concurrent mutations trivially race-free.
 * - Intended for single-process, personal-vault scale (documents up to ~64MB).
 */
class JsonStore {
  /**
   * @param {string} file absolute path of the JSON file
   * @param {object} initial default document used when the file does not exist
   */
  constructor(file, initial) {
    this.file = file;
    this.initial = initial;
    /** @type {object} */
    this.data = this.#load();
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return structuredClone(this.initial);
      }
      throw new Error(`Failed to read ${this.file}: ${err.message}`);
    }
  }

  /** Durably persist the current in-memory document (blocking). */
  save() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { JsonStore };
