/** A stand-in for `pg` for tests that load a module only for its pure functions. It connects to nothing. */
class Pool {
  query() { throw new Error('pg stub: no database in a pure test'); }
  connect() { throw new Error('pg stub: no database in a pure test'); }
  on() { return this; }
  end() { return Promise.resolve(); }
}
module.exports = { Pool, types: { setTypeParser() {}, builtins: {} } };
