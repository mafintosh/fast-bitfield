module.exports = () => new SparseBitfield()

function allocIndex (bits) {
  if (!bits) {
    return [
      new Uint32Array(32 * 32),
      new Uint32Array(32),
      new Uint32Array(1)
    ]
  }
  return [bits, new Uint32Array(32 * 32), new Uint32Array(1)]
}

const MASK = []
for (var i = 0; i < 32; i++) MASK[i] = Math.pow(2, 31 - i) - 1

const MASK_INCL = []
for (var j = 0; j < 32; j++) MASK_INCL[j] = Math.pow(2, 32 - j) - 1

class Page {
  constructor () {
    this.bits = null
    this.oneOne = null
    this.allOne = null
    this.parent = null
    this.children = null
    this.offset = 0
    this.bitOffset = 0
  }

  init (bits) {
    if (bits) this.bits = new Uint32Array(32 * 32)
    else this.children = new Array(32 * 32 * 32)
    this.oneOne = allocIndex(this.bits)
    this.allOne = allocIndex(this.bits)
  }

  addChildPage (p, len) {
    const page = new Page()
    page.parent = this
    page.offset = p
    page.init(len === 32768)
    page.bitOffset = this.bitOffset + len * page.offset
    this.children[p] = page
    return page
  }

  set (index, bit) {
    const r = index & 31
    const b = (index - r) / 32
    const prev = this.bits[b]

    this.bits[b] = bit ? (prev | (0x80000000 >>> r)) : (prev & ~(0x80000000 >>> r))

    const upd = this.bits[b]
    if (upd === prev) return false

    this.updateAllOne(b, upd)
    this.updateOneOne(b, upd)

    return true
  }

  updateAllOne (b, upd) {
    var page = this
    var i = 1

    do {
      for (; i < page.allOne.length; i++) {
        const buf = page.allOne[i]
        const r = b & 31
        b = (b - r) / 32
        const prev = buf[b]
        buf[b] = upd === 0xffffffff ? (prev | (0x80000000 >>> r)) : (prev & ~(0x80000000 >>> r))
        upd = buf[b]
        if (upd === prev) return
      }

      b += page.offset
      page = page.parent
      i = 0
    } while (page)
  }

  updateOneOne (b, upd) {
    var page = this
    var i = 1

    do {
      for (; i < page.oneOne.length; i++) {
        const buf = page.oneOne[i]
        const r = b & 31
        b = (b - r) / 32
        const prev = buf[b]
        buf[b] = upd !== 0 ? (prev | (0x80000000 >>> r)) : (prev & ~(0x80000000 >>> r))
        upd = buf[b]
        if (upd === prev) return
      }

      b += page.offset
      page = page.parent
      i = 0
    } while (page)
  }

  get (index) {
    const r = index & 31
    const b = (index - r) / 32

    return (this.bits[b] & (0x80000000 >>> r)) !== 0
  }
}

class SparseBitfield {
  constructor () {
    this._page = new Page()
    this._page.init(true)
    this._maxLength = 32768
    this._first = this._page
  }

  _grow () {
    const page = new Page()
    page.init(false)
    page.children[0] = this._page
    page.children[0].parent = page
    this._maxLength *= 32768
    this._page = page
  }

  set (index, bit) {
    while (index >= this._maxLength) this._grow()

    var page = this._page
    var len = this._maxLength

    while (true) {
      if (!page.children) return page.set(index, bit)

      len /= 32768

      const r = index & (len - 1)
      const p = (index - r) / len

      page = page.children[p] || (bit ? page.addChildPage(p, len) : null)
      index = r
    }
  }

  get (index, bit) {
    if (index >= this.length) return false

    var page = this._page
    var len = this._maxLength

    while (page) {
      if (!page.children) return page.get(index)

      len /= 32768

      const r = index & (len - 1)
      const p = (index - r) / len

      page = page.children[p]
      index = r
    }

    return false
  }

  iterator () {
    return new Iterator(this)
  }
}

class Iterator {
  constructor (bitfield) {
    this._bitfield = bitfield
    this._currentPage = bitfield._first
    this._index = 0
  }

  seek (index) {
    if (index === 0) {
      this._currentPage = this._bitfield._first
      this._index = 0
      return this
    }

    var page = this._bitfield._page
    var len = this._bitfield._maxLength

    while (page.children) {
      len /= 32768

      const r = index & (len - 1)
      const p = (index - r) / len

      page = page.children[p]
      index = r
    }

    this._currentPage = page
    this._index = index

    return this
  }

  next (bit) {
    return bit ? this.nextTrue() : this.nextFalse()
  }

  nextTrue () {
    var page = this._currentPage
    var b = this._index
    var mask = MASK_INCL

    do {
      if (b < 32768) {
        for (var i = 0; i < page.oneOne.length; i++) {
          const r = b & 31
          b = (b - r) / 32
          const clz = Math.clz32(page.oneOne[i][b] & mask[r])
          if (clz !== 32) return this._downLeftTrue(page, i, b, clz)
          mask = MASK
        }
      }

      b = page.offset
      page = page.parent
    } while (page)

    return -1
  }

  nextFalse () {
    var page = this._currentPage
    var b = this._index
    var mask = MASK_INCL

    do {
      if (b < 32768) {
        for (var i = 0; i < page.allOne.length; i++) {
          const r = b & 31
          b = (b - r) / 32
          const clz = Math.clz32((~page.allOne[i][b]) & mask[r])
          if (clz !== 32) return this._downLeftFalse(page, i, b, clz)
          mask = MASK
        }
      }

      b = page.offset
      page = page.parent
    } while (page)

    return -1
  }

  _downLeftTrue (page, i, b, clz) {
    while (true) {
      while (i) {
        b = b * 32 + clz
        clz = Math.clz32(page.oneOne[--i][b])
      }

      b = b * 32 + clz

      if (!page.children) break
      page = page.children[b]
      i = page.oneOne.length
      b = 0
      clz = 0
    }

    this._index = b + 1
    this._currentPage = page

    return page.bitOffset + b
  }

  _downLeftFalse (page, i, b, clz) {
    while (true) {
      while (i) {
        b = b * 32 + clz
        clz = Math.clz32(~page.allOne[--i][b])
      }

      b = b * 32 + clz

      if (!page.children) break
      page = page.children[b]
      i = page.allOne.length
      b = 0
      clz = 0
    }

    this._index = b + 1
    this._currentPage = page

    return page.bitOffset + b
  }
}
