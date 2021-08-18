const crypto = require('crypto')
const { isPrimitiveType } = require('./utils')

/**
 * Return a random alphanumerical string of length len
 * There is a very small probability (less than 1/1,000,000) for the length to be less than len
 * (il the base64 conversion yields too many pluses and slashes) but
 * that's not an issue here
 * The probability of a collision is extremely small (need 3*10^12 documents to have one chance in a million of a collision)
 * See http://en.wikipedia.org/wiki/Birthday_problem
 */
const uid = len => crypto.randomBytes(Math.ceil(Math.max(8, len * 2)))
  .toString('base64')
  .replace(/[+/]/g, '')
  .slice(0, len)

function isMongoose () {
  return !!global.MONGOOSE_DRIVER_PATH
}

function isMongoId (input) {
  return typeof input === 'object' && input.constructor && input.constructor.name.toUpperCase() === 'ObjectID'.toUpperCase()
}

// To make cursor work with mongoose
function adaptToMongoose (cursor, options) {
  if (!options) {
    return cursor
  }

  const projectionKeys = Object.keys(options)
  const isMongooseOptions = projectionKeys.every((x) => ['limit', 'skip', 'sort', 'fields'].includes(x))

  if (isMongoose() && isMongooseOptions) {
    if (options.fields) {
      const isPureSelection = Object.values(options.fields).every((x) => typeof x !== 'object')
      if (isPureSelection) {
        cursor.projection(options.fields)
      } else {
        // FIXME: the merging from projection to query conditions may cause new problems
        cursor.query = Object.assign({}, cursor.query, options.fields)
      }
    }

    if (options.sort && typeof options.sort === 'object') {
      cursor.sort(options.sort)
    }
    if (typeof options.skip === 'number') {
      cursor.skip(options.skip)
    }
    if (typeof options.limit === 'number') {
      cursor.limit(options.limit)
    }
  } else {
    cursor.projection(options)
  }

  return cursor
}

function removeUndefined (obj) {
  if (isMongoId(obj) || isPrimitiveType(obj)) return obj
  for (const k in obj) {
    if (obj[k] === undefined) Array.isArray(obj) ? obj.splice(k, 1) : delete obj[k]
    else if (typeof obj[k] === 'object') {
      const isUndefined = removeUndefined(obj[k]) === undefined
      if (isUndefined) delete obj[k]
    }
  }
  if (!Array.isArray(obj) && Object.keys(obj).length === 0) return undefined
  return obj
}

// Interface
module.exports.uid = uid
module.exports.isMongoose = isMongoose
module.exports.isMongoId = isMongoId
module.exports.adaptToMongoose = adaptToMongoose
module.exports.removeUndefined = removeUndefined
