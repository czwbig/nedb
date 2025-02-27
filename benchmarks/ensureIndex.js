const async = require('async')
const program = require('commander')
const Datastore = require('../lib/datastore')
const commonUtilities = require('./commonUtilities')
const Profiler = require('./profiler')

const profiler = new Profiler('INSERT BENCH')
const benchDb = 'workspace/insert.bench.db'
const d = new Datastore(benchDb)

program
  .option('-n --number [number]', 'Size of the collection to test on', parseInt)
  .option('-i --with-index', 'Test with an index')
  .parse(process.argv)

const n = program.number || 10000

console.log('----------------------------')
console.log('Test with ' + n + ' documents')
console.log('----------------------------')

async.waterfall([
  async.apply(commonUtilities.prepareDb, benchDb),
  function (cb) {
    d.loadDatabase(function (err) {
      if (err) { return cb(err) }
      cb()
    })
  },
  function (cb) { profiler.beginProfiling(); return cb() },
  async.apply(commonUtilities.insertDocs, d, n, profiler),
  function (cb) {
    let i

    profiler.step('Begin calling ensureIndex ' + n + ' times')

    for (i = 0; i < n; i += 1) {
      d.ensureIndex({ fieldName: 'docNumber' })
      delete d.indexes.docNumber
    }

    console.log('Average time for one ensureIndex: ' + (profiler.elapsedSinceLastStep() / n) + 'ms')
    profiler.step('Finished calling ensureIndex ' + n + ' times')
  }
], function (err) {
  profiler.step('Benchmark finished')

  if (err) { return console.log('An error was encountered: ', err) }
})
