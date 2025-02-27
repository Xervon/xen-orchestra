import * as assert from 'assert'
import zlib from 'zlib'

import {
  SECTOR_SIZE,
  createStreamOptimizedHeader,
  unpackHeader,
  MARKER_GT,
  MARKER_GD,
  MARKER_FOOTER,
  MARKER_EOS,
} from './definitions'

/**
 * - block is an input bunch of bytes, VHD default size is 2MB
 * - grain is an output (VMDK) bunch of bytes, VMDK default is 64KB
 *  expected ratio for default values is 16 VMDK grains for one VHD block
 *  this function errors if blockSize < grainSize
 *  The generated file is streamoptimized, compressed grains, tables at the end.
 * @param diskName
 * @param diskCapacityBytes
 * @param blockSizeBytes
 * @param blockGenerator async generator of {lba:Number, block:Buffer} objects.
 * @param geometry an object of shape {sectorsPerTrackCylinder,heads,cylinders}
 * @returns an Async generator of Buffers representing the VMDK file fragments
 */
export async function generateVmdkData(
  diskName,
  diskCapacityBytes,
  blockSizeBytes,
  blockGenerator,
  geometry = {
    sectorsPerTrackCylinder: 63,
    heads: 16,
    cylinders: 10402,
  }
) {
  const cid = Math.floor(Math.random() * Math.pow(2, 32))
  const diskCapacitySectors = Math.ceil(diskCapacityBytes / SECTOR_SIZE)
  // Virtual Box can't parse indented descriptors
  const descriptor = `# Disk DescriptorFile
version=1
CID=${cid}
parentCID=ffffffff
createType="streamOptimized"
# Extent description
RW ${diskCapacitySectors} SPARSE "${diskName}"
# The Disk Data Base
#DDB
ddb.adapterType = "ide"
ddb.geometry.sectors = "${geometry.sectorsPerTrackCylinder}"
ddb.geometry.heads = "${geometry.heads}"
ddb.geometry.cylinders = "${geometry.cylinders}"
`
  const utf8Descriptor = Buffer.from(descriptor, 'utf8')
  const descriptorSizeSectors = Math.ceil(utf8Descriptor.length / SECTOR_SIZE)
  const descriptorBuffer = Buffer.alloc(descriptorSizeSectors * SECTOR_SIZE)
  utf8Descriptor.copy(descriptorBuffer)
  const headerData = createStreamOptimizedHeader(diskCapacitySectors, descriptorSizeSectors)
  const parsedHeader = unpackHeader(headerData.buffer)
  const grainSizeBytes = parsedHeader.grainSizeSectors * SECTOR_SIZE
  if (blockSizeBytes % grainSizeBytes !== 0 || blockSizeBytes === 0) {
    throw new Error(
      `createReadableVmdkStream can only accept block size multiple of ${grainSizeBytes}, got ${blockSizeBytes}`
    )
  }

  const grainTableEntries = headerData.grainTableEntries
  const tableBuffer = Buffer.alloc(grainTableEntries * 4)

  let streamPosition = 0
  let directoryOffset = 0

  const roundToSector = value => Math.ceil(value / SECTOR_SIZE) * SECTOR_SIZE

  function track(buffer) {
    assert.equal(streamPosition % SECTOR_SIZE, 0)
    if (buffer.length > 0) {
      streamPosition += buffer.length
    }
    return buffer
  }

  function createEmptyMarker(type) {
    const buff = Buffer.alloc(SECTOR_SIZE)
    buff.writeBigUInt64LE(BigInt(0), 0)
    buff.writeUInt32LE(0, 8)
    buff.writeUInt32LE(type, 12)
    return buff
  }

  function createDirectoryBuffer(grainDirectoryEntries, tablePosition) {
    const OFFSET_SIZE = 4
    directoryOffset = streamPosition
    const buff = Buffer.alloc(roundToSector(grainDirectoryEntries * OFFSET_SIZE))
    for (let i = 0; i < grainDirectoryEntries; i++) {
      buff.writeUInt32LE((tablePosition + i * parsedHeader.numGTEsPerGT * OFFSET_SIZE) / SECTOR_SIZE, i * OFFSET_SIZE)
    }
    return buff
  }

  function bufferIsBlank(buffer) {
    for (const b of buffer) {
      if (b !== 0) {
        return false
      }
    }
    return true
  }

  function createMarkedGrain(lbaBytes, buffer) {
    assert.strictEqual(buffer.length, grainSizeBytes)
    assert.strictEqual(lbaBytes % grainSizeBytes, 0)
    const markerOverHead = 12
    const compressed = zlib.deflateSync(buffer, { level: 9 })
    const outputBuffer = Buffer.alloc(roundToSector(markerOverHead + compressed.length))
    compressed.copy(outputBuffer, markerOverHead)
    outputBuffer.writeBigUInt64LE(BigInt(lbaBytes / SECTOR_SIZE), 0)
    outputBuffer.writeUInt32LE(compressed.length, 8)
    return outputBuffer
  }

  async function* emitBlock(blockLbaBytes, buffer, grainSizeBytes) {
    assert.strictEqual(buffer.length % grainSizeBytes, 0)
    const grainCount = buffer.length / grainSizeBytes
    for (let i = 0; i < grainCount; i++) {
      const grainLbaBytes = blockLbaBytes + i * grainSizeBytes
      const tableIndex = grainLbaBytes / grainSizeBytes
      const grainData = buffer.slice(i * grainSizeBytes, (i + 1) * grainSizeBytes)
      if (!bufferIsBlank(grainData)) {
        tableBuffer.writeUInt32LE(streamPosition / SECTOR_SIZE, tableIndex * 4)
        yield track(createMarkedGrain(grainLbaBytes, grainData))
      }
    }
  }

  async function* emitBlocks(grainSize, blockGenerator) {
    for await (const b of blockGenerator) {
      yield* emitBlock(b.lba, b.block, grainSize)
    }
  }

  async function* iterator() {
    yield track(headerData.buffer)
    yield track(descriptorBuffer)
    yield* emitBlocks(grainSizeBytes, blockGenerator)
    yield track(createEmptyMarker(MARKER_GT))
    const tableOffset = streamPosition
    yield track(tableBuffer)
    yield track(createEmptyMarker(MARKER_GD))
    yield track(createDirectoryBuffer(headerData.grainDirectoryEntries, tableOffset))
    yield track(createEmptyMarker(MARKER_FOOTER))
    const footer = createStreamOptimizedHeader(
      diskCapacitySectors,
      descriptorSizeSectors,
      directoryOffset / SECTOR_SIZE
    )
    yield track(footer.buffer)
    yield track(createEmptyMarker(MARKER_EOS))
  }

  return iterator()
}
