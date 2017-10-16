'use strict'

const BB = require('bluebird')

const fs = BB.promisifyAll(require('fs'))
const index = require('./lib/entry-index')
const memo = require('./lib/memoization')
const pipe = require('mississippi').pipe
const pipeline = require('mississippi').pipeline
const read = require('./lib/content/read')
const through = require('mississippi').through

module.exports = function get (cache, key, opts) {
  return getData(false, cache, key, opts)
}
module.exports.byDigest = function getByDigest (cache, digest, opts) {
  return getData(true, cache, digest, opts)
}
function getData (byDigest, cache, key, opts) {
  opts = opts || {}
  const memoized = (
    byDigest
    ? memo.get.byDigest(cache, key, opts)
    : memo.get(cache, key, opts)
  )
  if (memoized && opts.memoize !== false) {
    return BB.resolve(byDigest ? memoized : {
      metadata: memoized.entry.metadata,
      data: memoized.data,
      integrity: memoized.entry.integrity,
      size: memoized.entry.size
    })
  }
  return (
    byDigest ? BB.resolve(null) : index.find(cache, key, opts)
  ).then(entry => {
    if (!entry && !byDigest) {
      throw new index.NotFoundError(cache, key)
    }
    return read(cache, byDigest ? key : entry.integrity, {
      integrity: opts.integrity,
      size: opts.size
    }).then(data => byDigest ? data : {
      metadata: entry.metadata,
      data: data,
      size: entry.size,
      integrity: entry.integrity
    }).then(res => {
      if (opts.memoize && byDigest) {
        memo.put.byDigest(cache, key, res, opts)
      } else if (opts.memoize) {
        memo.put(cache, entry, res.data, opts)
      }
      return res
    })
  })
}

module.exports.stream = getStream
function getStream (cache, key, opts) {
  opts = opts || {}
  let stream = through()
  const memoized = memo.get(cache, key, opts)
  if (memoized && opts.memoize !== false) {
    stream.on('newListener', function (ev, cb) {
      ev === 'metadata' && cb(memoized.entry.metadata)
      ev === 'integrity' && cb(memoized.entry.integrity)
      ev === 'size' && cb(memoized.entry.size)
    })
    stream.write(memoized.data, () => stream.end())
    return stream
  }
  index.find(cache, key).then(entry => {
    if (!entry) {
      return stream.emit(
        'error', new index.NotFoundError(cache, key)
      )
    }
    let memoStream
    if (opts.memoize) {
      let memoData = []
      let memoLength = 0
      memoStream = through((c, en, cb) => {
        memoData && memoData.push(c)
        memoLength += c.length
        cb(null, c, en)
      }, cb => {
        memoData && memo.put(cache, entry, Buffer.concat(memoData, memoLength), opts)
        cb()
      })
    } else {
      memoStream = through()
    }
    opts.size = opts.size == null ? entry.size : opts.size
    stream.emit('metadata', entry.metadata)
    stream.emit('integrity', entry.integrity)
    stream.emit('size', entry.size)
    stream.on('newListener', function (ev, cb) {
      ev === 'metadata' && cb(entry.metadata)
      ev === 'integrity' && cb(entry.integrity)
      ev === 'size' && cb(entry.size)
    })
    pipe(
      read.readStream(cache, entry.integrity, opts),
      memoStream,
      stream
    )
  }, err => stream.emit('error', err))
  return stream
}

module.exports.stream.byDigest = getStreamDigest
function getStreamDigest (cache, integrity, opts) {
  opts = opts || {}
  const memoized = memo.get.byDigest(cache, integrity, opts)
  if (memoized && opts.memoize !== false) {
    const stream = through()
    stream.write(memoized, () => stream.end())
    return stream
  } else {
    let stream = read.readStream(cache, integrity, opts)
    if (opts.memoize) {
      let memoData = []
      let memoLength = 0
      const memoStream = through((c, en, cb) => {
        memoData && memoData.push(c)
        memoLength += c.length
        cb(null, c, en)
      }, cb => {
        memoData && memo.put.byDigest(
          cache,
          integrity,
          Buffer.concat(memoData, memoLength),
          opts
        )
        cb()
      })
      stream = pipeline(stream, memoStream)
    }
    return stream
  }
}

module.exports.info = info
function info (cache, key, opts) {
  opts = opts || {}
  const memoized = memo.get(cache, key, opts)
  if (memoized && opts.memoize !== false) {
    return BB.resolve(memoized.entry)
  } else {
    return index.find(cache, key)
  }
}

module.exports.hasContent = read.hasContent

module.exports.copy = function cp (cache, key, dest, opts) {
  return copy(false, cache, key, dest, opts)
}
module.exports.copy.byDigest = function cpDigest (cache, digest, dest, opts) {
  return copy(true, cache, digest, dest, opts)
}
function copy (byDigest, cache, key, dest, opts) {
  opts = opts || {}
  if (read.copy) {
    return (
      byDigest ? BB.resolve(null) : index.find(cache, key, opts)
    ).then(entry => {
      if (!entry && !byDigest) {
        throw new index.NotFoundError(cache, key)
      }
      return BB.join(
        read.copy(cache, byDigest ? key : entry.integrity, dest, opts),
        opts.unsafe ? null : getData(byDigest, cache, key, opts),
        info => {
          const mtime = opts.mtime != null && +(new Date(opts.mtime))
          const mode = opts.mode != null &&
          (info.stat.isFile() ? 0o100000 : 0o40000) | opts.mode
          const needsMode = mode && mode !== info.stat.mode
          const needsTime = mtime && mtime !== info.stat.mtime
          if (needsMode || needsTime) {
            return BB.join(
              needsMode && fs.chmodAsync(dest, mode),
              needsTime && fs.utimesAsync(dest, Date.now(), new Date(mtime))
            )
          }
        }
      )
      .then(() => byDigest ? key : {
        metadata: entry.metadata,
        size: entry.size,
        integrity: entry.integrity
      })
    })
  } else {
    return getData(byDigest, cache, key, opts).then(res => {
      return fs.writeFileAsync(dest, byDigest ? res : res.data)
      .then(() => byDigest ? key : {
        metadata: res.metadata,
        size: res.size,
        integrity: res.integrity
      })
    })
  }
}
