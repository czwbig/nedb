const uniq = (array, iterator) => {
  if (iterator) return [...(new Map(array.map(x => [iterator(x), x]))).values()]
  else return [...new Set(array)]
}

const objectToString = o => Object.prototype.toString.call(o)

const isObject = arg => typeof arg === 'object' && arg !== null

const isDate = d => isObject(d) && objectToString(d) === '[object Date]'

const isRegExp = re => isObject(re) && objectToString(re) === '[object RegExp]'

/**
 * Tells if an object is a primitive type or a "real" object
 * Arrays are considered primitive
 */
const isPrimitiveType = obj => (
  typeof obj === 'boolean' ||
  typeof obj === 'number' ||
  typeof obj === 'string' ||
  obj === null ||
  isDate(obj) ||
  Array.isArray(obj)
)

module.exports.uniq = uniq
module.exports.isDate = isDate
module.exports.isRegExp = isRegExp
module.exports.isPrimitiveType = isPrimitiveType
