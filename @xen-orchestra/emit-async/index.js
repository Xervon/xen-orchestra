'use strict'

module.exports = function emitAsync(event) {
  let opts
  let i = 1

  // an option object has been passed as first param
  if (typeof event !== 'string') {
    opts = event
    event = arguments[i++]
  }

  const n = arguments.length - i
  const args = new Array(n)
  for (let j = 0; j < n; ++j) {
    args[j] = arguments[j + i]
  }

  const onError = opts != null && opts.onError

  return Promise.all(
    this.listeners(event).map(listener =>
      new Promise(resolve => {
        resolve(listener.apply(this, args))
      }).catch(onError)
    )
  )
}
