// Thin CLI bridge so nrfi/model.py (Python) can call into nrfi/data.js
// (Node) without duplicating its MLB Stats API fetch/cache logic. Usage:
//   node bridge.js <exportedFnName> <jsonArg1> <jsonArg2> ...
// Prints the function's resolved value as JSON on stdout.

const data = require('./data.js');

async function main() {
  const [fnName, ...rawArgs] = process.argv.slice(2);
  const fn = data[fnName];
  if (typeof fn !== 'function') {
    throw new Error(`nrfi/data.js has no exported function "${fnName}"`);
  }

  const args = rawArgs.map(a => JSON.parse(a));
  const result = await fn(...args);
  process.stdout.write(JSON.stringify(result ?? null));
}

main().catch(err => {
  process.stderr.write((err.stack || err.message) + '\n');
  process.exit(1);
});
