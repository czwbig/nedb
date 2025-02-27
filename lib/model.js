/**
 * Handle models (i.e. docs)
 * Serialization/deserialization
 * Copying
 * Querying, update
 */

const { assert } = require('chai')
const R = require('ramda')
const { isMongoId, isMongoose } = require('./customUtils')
const { uniq, isDate, isRegExp, isPrimitiveType } = require('./utils.js')
const modifierFunctions = {}
const lastStepModifierFunctions = {}
const comparisonFunctions = {}
const logicalOperators = {}
const arrayComparisonFunctions = {}

/**
 * Check a key, throw an error if the key is non valid
 * @param {String} k key
 * @param {Model} v value, needed to treat the Date edge case
 * Non-treatable edge cases here: if part of the object if of the form { $$date: number } or { $$deleted: true }
 * Its serialized-then-deserialized version it will transformed into a Date object
 * But you really need to want it to trigger such behaviour, even when warned not to use '$' at the beginning of the field names...
 */
const checkKey = (k, v) => {
  if (typeof k === 'number') k = k.toString()

  if (
    k[0] === '$' &&
    !(k === '$$date' && typeof v === 'number') &&
    !(k === '$$deleted' && v === true) &&
    !(k === '$$indexCreated') &&
    !(k === '$$indexRemoved') &&
    !(k === '$numberDecimal')
  ) throw new Error('Field names cannot begin with the $ character')

  if (k.indexOf('.') !== -1) throw new Error('Field names cannot contain a .')
}

/**
 * Check a DB object and throw an error if it's not valid
 * Works by applying the above checkKey function to all fields recursively
 */
const checkObject = obj => {
  if (Array.isArray(obj)) {
    obj.forEach(o => {
      checkObject(o)
    })
    return
  }

  if (typeof obj === 'object' && obj !== null) {
    for (const k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        checkKey(k, obj[k])
        checkObject(obj[k])
      }
    }
  }
}

/**
 * Serialize an object to be persisted to a one-line string
 * For serialization/deserialization, we use the native JSON parser and not eval or Function
 * That gives us less freedom but data entered in the database may come from users
 * so eval and the like are not safe
 * Accepted primitive types: Number, String, Boolean, Date, null
 * Accepted secondary types: Objects, Arrays
 */
const serialize = obj => {
  return JSON.stringify(obj, function (k, v) {
    checkKey(k, v)

    if (v === undefined) return undefined
    if (v === null) return null

    // Hackish way of checking if object is Date (this way it works between execution contexts in node-webkit).
    // We can't use value directly because for dates it is already string in this function (date.toJSON was already called), so we use this
    if (typeof this[k].getTime === 'function') return { $$date: this[k].getTime() }

    return v
  })
}

/**
 * From a one-line representation of an object generate by the serialize function
 * Return the object itself
 */
const deserialize = rawData => JSON.parse(rawData, function (k, v) {
  if (k === '$$date') return new Date(v)
  if (
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    v === null
  ) return v
  if (v && v.$$date) return v.$$date

  return v
})

/**
 * Deep copy a DB object
 * The optional strictKeys flag (defaulting to false) indicates whether to copy everything or only fields
 * where the keys are valid, i.e. don't begin with $ and don't contain a .
 */
function deepCopy (obj, strictKeys) {
  if (
    typeof obj === 'boolean' ||
    typeof obj === 'number' ||
    typeof obj === 'string' ||
    obj === null ||
    (isDate(obj)) ||
    (obj && obj._bsontype === 'ObjectID')
  ) return obj

  if (Array.isArray(obj)) return obj.map(o => deepCopy(o, strictKeys))

  if (typeof obj === 'object') {
    const res = {}
    for (const k in obj) {
      if (
        Object.prototype.hasOwnProperty.call(obj, k) &&
        (!strictKeys || (k[0] !== '$' && k.indexOf('.') === -1))
      ) {
        res[k] = deepCopy(obj[k], strictKeys)
      }
    }
    return res
  }

  return undefined // For now everything else is undefined. We should probably throw an error instead
}

/**
 * Utility functions for comparing things
 * Assumes type checking was already done (a and b already have the same type)
 * compareNSB works for numbers, strings and booleans
 */
const compareNSB = (a, b) => {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

const compareArrays = (a, b) => {
  const minLength = Math.min(a.length, b.length)
  for (let i = 0; i < minLength; i += 1) {
    const comp = compareThings(a[i], b[i])

    if (comp !== 0) return comp
  }

  // Common section was identical, longest one wins
  return compareNSB(a.length, b.length)
}

/**
 * Compare { things U undefined }
 * Things are defined as any native types (string, number, boolean, null, date) and objects
 * We need to compare with undefined as it will be used in indexes
 * In the case of objects and arrays, we deep-compare
 * If two objects dont have the same type, the (arbitrary) type hierarchy is: undefined, null, number, strings, boolean, dates, arrays, objects
 * Return -1 if a < b, 1 if a > b and 0 if a = b (note that equality here is NOT the same as defined in areThingsEqual!)
 *
 * @param {Function} _compareStrings String comparing function, returning -1, 0 or 1, overriding default string comparison (useful for languages with accented
 *   letters)
 */
const compareThings = (a, b, _compareStrings) => {
  const compareStrings = _compareStrings || compareNSB

  // Custom type (ex: bson.ObjectID)
  if (isMongoId(a)) a = a.toString()
  if (isMongoId(b)) b = b.toString()

  // undefined
  if (a === undefined) return b === undefined ? 0 : -1
  if (b === undefined) return 1 // no need to test if a === undefined

  // null
  if (a === null) return b === null ? 0 : -1
  if (b === null) return 1 // no need to test if a === null

  // Numbers
  if (typeof a === 'number') return typeof b === 'number' ? compareNSB(a, b) : -1
  if (typeof b === 'number') return typeof a === 'number' ? compareNSB(a, b) : 1

  // Strings
  if (typeof a === 'string') return typeof b === 'string' ? compareStrings(a, b) : -1
  if (typeof b === 'string') return typeof a === 'string' ? compareStrings(a, b) : 1

  // Booleans
  if (typeof a === 'boolean') return typeof b === 'boolean' ? compareNSB(a, b) : -1
  if (typeof b === 'boolean') return typeof a === 'boolean' ? compareNSB(a, b) : 1

  // Dates
  if (isDate(a)) return isDate(b) ? compareNSB(a.getTime(), b.getTime()) : -1
  if (isDate(b)) return isDate(a) ? compareNSB(a.getTime(), b.getTime()) : 1

  // Arrays (first element is most significant and so on)
  if (Array.isArray(a)) return Array.isArray(b) ? compareArrays(a, b) : -1
  if (Array.isArray(b)) return Array.isArray(a) ? compareArrays(a, b) : 1

  // Objects
  const aKeys = Object.keys(a).sort()
  const bKeys = Object.keys(b).sort()

  for (let i = 0; i < Math.min(aKeys.length, bKeys.length); i += 1) {
    const comp = compareThings(a[aKeys[i]], b[bKeys[i]])

    if (comp !== 0) return comp
  }

  return compareNSB(aKeys.length, bKeys.length)
}

// ==============================================================
// Updating documents
// ==============================================================

/**
 * The signature of modifier functions is as follows
 * Their structure is always the same: recursively follow the dot notation while creating
 * the nested documents if needed, then apply the "last step modifier"
 * @param {Object} obj The model to modify
 * @param {String} field Can contain dots, in that case that means we will set a subfield recursively
 * @param {Model} value
 */

/**
 * Set a field to a new value
 */
lastStepModifierFunctions.$set = (obj, field, value) => {
  obj[field] = value
}

/**
 * Unset a field
 */
lastStepModifierFunctions.$unset = (obj, field, value) => {
  delete obj[field]
}

/**
 * Push an element to the end of an array field
 * Optional modifier $each instead of value to push several values
 * Optional modifier $slice to slice the resulting array, see https://docs.mongodb.org/manual/reference/operator/update/slice/
 * Différeence with MongoDB: if $slice is specified and not $each, we act as if value is an empty array
 */
lastStepModifierFunctions.$push = (obj, field, value) => {
  // Create the array if it doesn't exist
  if (!Object.prototype.hasOwnProperty.call(obj, field)) obj[field] = []

  if (!Array.isArray(obj[field])) throw new Error('Can\'t $push an element on non-array values')

  if (
    value !== null &&
    typeof value === 'object' &&
    value.$slice &&
    value.$each === undefined
  ) value.$each = []

  if (value !== null && typeof value === 'object' && value.$each) {
    if (
      Object.keys(value).length >= 3 ||
      (Object.keys(value).length === 2 && value.$slice === undefined)
    ) throw new Error('Can only use $slice in cunjunction with $each when $push to array')
    if (!Array.isArray(value.$each)) throw new Error('$each requires an array value')

    value.$each.forEach(v => {
      obj[field].push(v)
    })

    if (value.$slice === undefined || typeof value.$slice !== 'number') return

    if (value.$slice === 0) obj[field] = []
    else {
      let start
      let end
      const n = obj[field].length
      if (value.$slice < 0) {
        start = Math.max(0, n + value.$slice)
        end = n
      } else if (value.$slice > 0) {
        start = 0
        end = Math.min(n, value.$slice)
      }
      obj[field] = obj[field].slice(start, end)
    }
  } else {
    obj[field].push(value)
  }
}

lastStepModifierFunctions.$pushAll = (obj, field, values) => {
  if (!Array.isArray(values)) throw new Error('Can\'t $pushAll an non-array element, try $push')
  return lastStepModifierFunctions.$push(obj, field, { $each: values })
}

/**
 * Add an element to an array field only if it is not already in it
 * No modification if the element is already in the array
 * Note that it doesn't check whether the original array contains duplicates
 */
lastStepModifierFunctions.$addToSet = (obj, field, value) => {
  // Create the array if it doesn't exist
  if (!Object.prototype.hasOwnProperty.call(obj, field)) {
    obj[field] = []
  }

  if (!Array.isArray(obj[field])) throw new Error('Can\'t $addToSet an element on non-array values')

  if (value !== null && typeof value === 'object' && value.$each) {
    if (Object.keys(value).length > 1) throw new Error('Can\'t use another field in conjunction with $each')
    if (!Array.isArray(value.$each)) throw new Error('$each requires an array value')

    value.$each.forEach(v => {
      lastStepModifierFunctions.$addToSet(obj, field, v)
    })
  } else {
    let addToSet = true
    obj[field].forEach(v => {
      if (compareThings(v, value) === 0) addToSet = false
    })
    if (addToSet) obj[field].push(value)
  }
}

/**
 * Remove the first or last element of an array
 */
lastStepModifierFunctions.$pop = (obj, field, value) => {
  if (!Array.isArray(obj[field])) throw new Error('Can\'t $pop an element from non-array values')
  if (typeof value !== 'number') throw new Error(`${value} isn't an integer, can't use it with $pop`)
  if (value === 0) return

  if (value > 0) obj[field] = obj[field].slice(0, obj[field].length - 1)
  else obj[field] = obj[field].slice(1)
}

/**
 * Removes all instances of a value from an existing array
 */
lastStepModifierFunctions.$pull = (obj, field, value) => {
  if (!Array.isArray(obj[field])) throw new Error('Can\'t $pull an element from non-array values')
  const arr = obj[field]
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (match(arr[i], value)) arr.splice(i, 1)
  }
}

lastStepModifierFunctions.$pullAll = (obj, field, values) => {
  if (!Array.isArray(obj[field])) throw new Error('Can\'t $pullAll an element from non-array values')
  if (!Array.isArray(values)) throw new Error('Can\'t $pullAll an non-array element, try $pull')

  const arr = obj[field]
  obj[field] = arr.filter(e => !values.some(value => match(e, value)))
}

/**
 * Increment a numeric field's value
 */
lastStepModifierFunctions.$inc = (obj, field, value) => {
  if (typeof value !== 'number') throw new Error(`${value} must be a number`)
  if (typeof obj[field] !== 'number') {
    if (obj[field] === undefined) obj[field] = value
    else throw new Error('Don\'t use the $inc modifier on non-number fields')
  } else obj[field] += value
}

/**
 * Updates the value of the field, only if specified field is greater than the current value of the field
 */
lastStepModifierFunctions.$max = (obj, field, value) => {
  if (typeof obj[field] === 'undefined') obj[field] = value
  else if (value > obj[field]) obj[field] = value
}

/**
 * Updates the value of the field, only if specified field is smaller than the current value of the field
 */
lastStepModifierFunctions.$min = (obj, field, value) => {
  if (typeof obj[field] === 'undefined') obj[field] = value
  else if (value < obj[field]) obj[field] = value
}

// Given its name, create the complete modifier function
const createModifierFunction = modifier => (obj, field, value, query) => {
  const fieldParts = typeof field === 'string' ? field.split('.') : field

  function helper (el) {
    if (fieldParts.length === 1) {
      lastStepModifierFunctions[modifier](el, fieldParts[0], value)
    } else {
      if (el[fieldParts[0]] === undefined) {
        if (modifier === '$unset') return // Bad looking specific fix, needs to be generalized modifiers that behave like $unset are implemented
        el[fieldParts[0]] = {}
      }
      const dollarIndex = fieldParts.indexOf('$')
      if (!query || dollarIndex === -1) {
        return modifierFunctions[modifier](el[fieldParts[0]], fieldParts.slice(1), value)
      }
      assert.strictEqual(fieldParts.lastIndexOf('$'), dollarIndex, 'Can only contain one $')
      assert.ok(dollarIndex > 0, '$ can not be in the first place')
      const arrayPath = fieldParts.slice(0, dollarIndex).join('.')
      const array = getDotValue(obj, arrayPath)
      const matchArrayIndexs = R.filter(i => match(modify(obj, { $set: { [arrayPath]: [array[i]] } }), query))(R.range(0, R.length(array)))
      if (matchArrayIndexs.length === 0) {
        return modifierFunctions[modifier](el[fieldParts[0]], fieldParts.slice(1).filter(e => e !== '$'), value)
      }
      R.pipe(
        R.map(index => R.update(dollarIndex, index, fieldParts)),
        R.forEach(thisFieldParts => modifierFunctions[modifier](el[thisFieldParts[0]], thisFieldParts.slice(1), value))
      )(matchArrayIndexs)
    }
  }

  if (Array.isArray(obj) && isNaN(parseInt(fieldParts[0]))) {
    obj.forEach(helper)
  } else {
    helper(obj)
  }
}

// Actually create all modifier functions
Object.keys(lastStepModifierFunctions).forEach(modifier => {
  modifierFunctions[modifier] = createModifierFunction(modifier)
})

function isMongooseDocument (obj) {
  return obj && typeof obj.toObject === 'function' && typeof obj.toJSON === 'function'
}

function mongooseModelToObject (obj) {
  if (isMongooseDocument(obj)) return obj.toObject()
  if (Array.isArray(obj)) return obj.map(v => mongooseModelToObject(v))
  for (const key in obj) {
    const value = obj[key]
    if (isMongooseDocument(value)) {
      obj[key] = value.toObject()
      continue
    }
    if (Array.isArray(value)) {
      obj[key] = value.map(v => mongooseModelToObject(v))
      continue
    }
    if (!isPrimitiveType(obj)) {
      obj[key] = mongooseModelToObject(value)
    }
  }
  return obj
}

/**
 * Modify a DB object according to an update query
 */
const modify = (obj, updateQuery, query) => {
  if (isMongoose()) {
    mongooseModelToObject(updateQuery)
  }
  const keys = Object.keys(updateQuery)
  const firstChars = keys.map(item => item[0])
  const dollarFirstChars = firstChars.filter(c => c === '$')
  let newDoc
  let modifiers

  if (keys.indexOf('_id') !== -1 && updateQuery._id !== obj._id) throw new Error('You cannot change a document\'s _id')

  if (dollarFirstChars.length !== 0 && dollarFirstChars.length !== firstChars.length) throw new Error('You cannot mix modifiers and normal fields')

  if (dollarFirstChars.length === 0) {
    // Simply replace the object with the update query contents
    newDoc = deepCopy(updateQuery)
    newDoc._id = obj._id
  } else {
    // Apply modifiers
    modifiers = uniq(keys)
    newDoc = deepCopy(obj)
    modifiers.forEach(m => {
      if (!modifierFunctions[m]) throw new Error(`Unknown modifier ${m}`)

      // Can't rely on Object.keys throwing on non objects since ES6
      // Not 100% satisfying as non objects can be interpreted as objects but no false negatives so we can live with it
      if (typeof updateQuery[m] !== 'object') throw new Error(`Modifier ${m}'s argument must be an object`)

      const keys = Object.keys(updateQuery[m])
      keys.forEach(k => {
        modifierFunctions[m](newDoc, k, updateQuery[m][k], query)
      })
    })
  }

  // Check result is valid and return it
  checkObject(newDoc)

  if (obj._id !== newDoc._id) throw new Error('You can\'t change a document\'s _id')
  return newDoc
}

// ==============================================================
// Finding documents
// ==============================================================

/**
 * Get a value from object with dot notation
 * @param {Object} obj
 * @param {String} field
 */
const getDotValue = (obj, field) => {
  const fieldParts = typeof field === 'string' ? field.split('.') : field

  if (!obj) return undefined // field cannot be empty so that means we should return undefined so that nothing can match

  if (fieldParts.length === 0) return obj

  if (fieldParts.length === 1) return obj[fieldParts[0]]

  if (Array.isArray(obj[fieldParts[0]])) {
    // If the next field is an integer, return only this item of the array
    const i = parseInt(fieldParts[1], 10)
    if (typeof i === 'number' && !isNaN(i)) return getDotValue(obj[fieldParts[0]][i], fieldParts.slice(2))

    // Return the array of values
    return obj[fieldParts[0]].map(el => getDotValue(el, fieldParts.slice(1)))
  } else return getDotValue(obj[fieldParts[0]], fieldParts.slice(1))
}

/**
 * Get a value from object with dot notation
 * @param {Object} obj
 * @param {String} field
 */
const getObjDotValue = (obj, field) => {
  const fieldParts = typeof field === 'string' ? field.split('.') : field

  if (!obj) return undefined // field cannot be empty so that means we should return undefined so that nothing can match

  if (fieldParts.length === 0) return obj

  const firstFieldPart = fieldParts[0]
  if (obj[firstFieldPart] === undefined) return {}

  if (fieldParts.length === 1) return R.pick([firstFieldPart])(obj)

  if (Array.isArray(obj[firstFieldPart])) {
    // If the next field is an integer, return only this item of the array
    const i = parseInt(fieldParts[1], 10)
    if (typeof i === 'number' && !isNaN(i)) return getObjDotValue(obj[firstFieldPart][i], fieldParts.slice(2))

    // Return the array of values
    let hasContent = false
    const returnArray = obj[firstFieldPart].map(el => {
      const value = getObjDotValue(el, fieldParts.slice(1))
      if (value !== undefined && Object.keys(value).length > 0) hasContent = true
      return value
    })
    return {
      [firstFieldPart]: hasContent ? returnArray : []
    }
  }
  return { [firstFieldPart]: getObjDotValue(obj[firstFieldPart], fieldParts.slice(1)) }
}

/**
 * Check whether 'things' are equal
 * Things are defined as any native types (string, number, boolean, null, date) and objects
 * In the case of object, we check deep equality
 * Returns true if they are, false otherwise
 */
const areThingsEqual = (a, b) => {
  // Custom type (ex: bson.ObjectID)
  if (isMongoId(a)) a = a.toString()
  if (isMongoId(b)) b = b.toString()

  // Strings, booleans, numbers, null
  if (
    a === null ||
    typeof a === 'string' ||
    typeof a === 'boolean' ||
    typeof a === 'number' ||
    b === null ||
    typeof b === 'string' ||
    typeof b === 'boolean' ||
    typeof b === 'number'
  ) return a === b

  // Dates
  if (isDate(a) || isDate(b)) return isDate(a) && isDate(b) && a.getTime() === b.getTime()

  // Arrays (no match since arrays are used as a $in)
  // undefined (no match since they mean field doesn't exist and can't be serialized)
  if (
    (!(Array.isArray(a) && Array.isArray(b)) && (Array.isArray(a) || Array.isArray(b))) ||
    a === undefined || b === undefined
  ) return false

  // General objects (check for deep equality)
  // a and b should be objects at this point
  let aKeys
  let bKeys
  try {
    aKeys = Object.keys(a)
    bKeys = Object.keys(b)
  } catch (e) {
    return false
  }

  if (aKeys.length !== bKeys.length) return false
  for (const el of aKeys) {
    if (bKeys.indexOf(el) === -1) return false
    if (!areThingsEqual(a[el], b[el])) return false
  }
  return true
}

/**
 * Check that two values are comparable
 */
const areComparable = (a, b) => {
  if (
    typeof a !== 'string' &&
    typeof a !== 'number' &&
    !isDate(a) &&
    typeof b !== 'string' &&
    typeof b !== 'number' &&
    !isDate(b)
  ) return false

  if (typeof a !== typeof b) return false

  return true
}

/**
 * Arithmetic and comparison operators
 * @param {Native value} a Value in the object
 * @param {Native value} b Value in the query
 */
comparisonFunctions.$lt = (a, b) => areComparable(a, b) && a < b

comparisonFunctions.$lte = (a, b) => areComparable(a, b) && a <= b

comparisonFunctions.$gt = (a, b) => areComparable(a, b) && a > b

comparisonFunctions.$gte = (a, b) => areComparable(a, b) && a >= b

comparisonFunctions.$ne = (a, b) => {
  if (a === undefined) return true
  if (Array.isArray(a) && !Array.isArray(b)) {
    return !a.some(el => areThingsEqual(el, b))
  }
  return !areThingsEqual(a, b)
}

comparisonFunctions.$eq = (a, b) => {
  return areThingsEqual(a, b)
}

comparisonFunctions.$in = (a, b) => {
  if (!Array.isArray(b)) throw new Error('$in operator called with a non-array')

  for (const el of b) {
    if (areThingsEqual(a, el)) return true
  }

  return false
}

comparisonFunctions.$nin = (a, b) => {
  if (!Array.isArray(b)) throw new Error('$nin operator called with a non-array')

  return !comparisonFunctions.$in(a, b)
}

comparisonFunctions.$regex = (a, b) => {
  if (!isRegExp(b)) {
    if (typeof b !== 'string') throw new Error('$regex operator called with non regular expression')
    try {
      b = new RegExp(b)
    } catch (e) {
      throw new Error('$regex operator called with non regular expression')
    }
  }

  if (typeof a !== 'string') return false
  else return b.test(a)
}

comparisonFunctions.$exists = (value, exists) => {
  // This will be true for all values of stat except false, null, undefined and 0
  // That's strange behaviour (we should only use true/false) but that's the way Mongo does it...
  if (exists || exists === '') exists = true
  else exists = false

  if (value === undefined) return !exists
  else return exists
}

// Specific to arrays
comparisonFunctions.$size = (obj, value) => {
  if (!Array.isArray(obj)) return false
  if (value % 1 !== 0) throw new Error('$size operator called without an integer')

  return obj.length === value
}

comparisonFunctions.$elemMatch = (obj, value) => {
  if (!Array.isArray(obj)) return false
  return obj.some(el => match(el, value))
}

arrayComparisonFunctions.$size = true
arrayComparisonFunctions.$elemMatch = true
arrayComparisonFunctions.$ne = true

/**
 * Match any of the subqueries
 * @param {Model} obj
 * @param {Array of Queries} query
 */
logicalOperators.$or = (obj, query) => {
  if (!Array.isArray(query)) throw new Error('$or operator used without an array')

  for (let i = 0; i < query.length; i += 1) {
    if (match(obj, query[i])) return true
  }

  return false
}

/**
 * Match all of the subqueries
 * @param {Model} obj
 * @param {Array of Queries} query
 */
logicalOperators.$and = (obj, query) => {
  if (!Array.isArray(query)) throw new Error('$and operator used without an array')

  for (let i = 0; i < query.length; i += 1) {
    if (!match(obj, query[i])) return false
  }

  return true
}

/**
 * Inverted match of the query
 * @param {Model} obj
 * @param {Query} query
 */
logicalOperators.$not = (obj, query) => !match(obj, query)

/**
 * Use a function to match
 * @param {Model} obj
 * @param {Function|String} fn
 */
logicalOperators.$where = (obj, fn) => {
  if (typeof fn === 'string') {
    try {
      // eslint-disable-next-line no-new-func
      fn = new Function(`return ${fn}`)
    } catch (e) {
      try {
        // eslint-disable-next-line no-new-func
        fn = new Function(/{([?\S\s]+)}/.exec(fn)[1].trim())
      } catch (e) {
      }
    }
  }
  if (typeof fn !== 'function') throw new Error('$where operator used without a function')

  const result = fn.call(obj)
  if (result !== undefined && typeof result !== 'boolean') throw new Error('$where function must return boolean')

  return result
}

/**
 * Tell if a given document matches a query
 * @param {Object} obj Document to check
 * @param {Object} query
 */
const match = (obj, query) => {
  // Primitive query against a primitive type
  // This is a bit of a hack since we construct an object with an arbitrary key only to dereference it later
  // But I don't have time for a cleaner implementation now
  if (isPrimitiveType(obj) || isPrimitiveType(query) || isMongoId(obj) || isMongoId(query)) return matchQueryPart({ needAKey: obj }, 'needAKey', query)

  // Normal query
  for (const queryKey in query) {
    if (Object.prototype.hasOwnProperty.call(query, queryKey)) {
      const queryValue = query[queryKey]
      if (queryKey[0] === '$') {
        if (!logicalOperators[queryKey]) throw new Error(`Unknown logical operator ${queryKey}`)
        if (!logicalOperators[queryKey](obj, queryValue)) return false
      } else if (!matchQueryPart(obj, queryKey, queryValue)) return false
    }
  }

  return true
}

/**
 * Match an object against a specific { key: value } part of a query
 * if the treatObjAsValue flag is set, don't try to match every part separately, but the array as a whole
 */
function matchQueryPart (obj, queryKey, queryValue, treatObjAsValue) {
  const objValue = getDotValue(obj, queryKey)

  // Check if the value is an array if we don't force a treatment as value
  if (Array.isArray(objValue) && !treatObjAsValue) {
    // If the queryValue is an array, try to perform an exact match
    if (Array.isArray(queryValue) || queryValue.$eq !== undefined) return matchQueryPart(obj, queryKey, queryValue, true)

    // Check if we are using an array-specific comparison function
    if (queryValue !== null && typeof queryValue === 'object' && !isRegExp(queryValue)) {
      for (const key in queryValue) {
        if (Object.prototype.hasOwnProperty.call(queryValue, key) && arrayComparisonFunctions[key]) {
          return matchQueryPart(obj, queryKey, queryValue, true)
        }
      }
    }

    // If not, treat it as an array of { obj, query } where there needs to be at least one match
    for (const el of objValue) {
      if (matchQueryPart({ k: el }, 'k', queryValue)) return true // k here could be any string
    }
    return false
  }

  // queryValue is an actual object. Determine whether it contains comparison operators
  // or only normal fields. Mixed objects are not allowed
  if (queryValue !== null && typeof queryValue === 'object' && !isRegExp(queryValue) && !Array.isArray(queryValue)) {
    if (R.intersection(Object.keys(queryValue), ['$regex', '$options']).length === 2) {
      queryValue = { $regex: new RegExp(queryValue.$regex, queryValue.$options) }
    }
    const keys = Object.keys(queryValue)
    const firstChars = keys.map(item => item[0])
    const dollarFirstChars = firstChars.filter(c => c === '$')

    if (dollarFirstChars.length !== 0 && dollarFirstChars.length !== firstChars.length) throw new Error('You cannot mix operators and normal fields')

    // queryValue is an object of this form: { $comparisonOperator1: value1, ... }
    if (dollarFirstChars.length > 0) {
      for (const key of keys) {
        if (!comparisonFunctions[key]) throw new Error(`Unknown comparison function ${key}`)

        if (!comparisonFunctions[key](objValue, queryValue[key])) return false
      }
      return true
    }
  }

  // Using regular expressions with basic querying
  if (isRegExp(queryValue)) return comparisonFunctions.$regex(objValue, queryValue)
  if (objValue === undefined && queryValue === null) return true
  // queryValue is either a native value or a normal object
  // Basic matching is possible
  return areThingsEqual(objValue, queryValue)
}

/**
 * Used primarily in compound indexes. Returns a comparison function usable as
 * an Index's compareKeys function.
 */
function compoundCompareThings (fields) {
  return function (a, b) {
    let i, len, comparison

    // undefined
    if (a === undefined) {
      return b === undefined ? 0 : -1
    }
    if (b === undefined) {
      return a === undefined ? 0 : 1
    }

    // null
    if (a === null) {
      return b === null ? 0 : -1
    }
    if (b === null) {
      return a === null ? 0 : 1
    }

    for (i = 0, len = fields.length; i < len; i++) {
      comparison = compareThings(a[fields[i]], b[fields[i]])
      if (comparison !== 0) {
        return comparison
      }
    }

    return 0
  }
}

// Interface
module.exports.serialize = serialize
module.exports.deserialize = deserialize
module.exports.deepCopy = deepCopy
module.exports.checkObject = checkObject
module.exports.isPrimitiveType = isPrimitiveType
module.exports.modify = modify
module.exports.getDotValue = getDotValue
module.exports.getObjDotValue = getObjDotValue
module.exports.match = match
module.exports.areThingsEqual = areThingsEqual
module.exports.compareThings = compareThings
module.exports.compoundCompareThings = compoundCompareThings
