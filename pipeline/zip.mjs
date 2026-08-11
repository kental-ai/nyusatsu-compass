// 最小ZIP展開（外部依存ゼロ）。GEPSの「CSV1本入りzip」専用の簡易実装。
// ローカルファイルヘッダ(PK\x03\x04)を走査し、store(0)/deflate(8)のみ対応。
import { inflateRawSync } from 'node:zlib';

export function unzipSingle(buf) {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('not a zip (no local file header)');
  const method = buf.readUInt16LE(8);
  const flags = buf.readUInt16LE(6);
  let compSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const dataStart = 30 + nameLen + extraLen;

  // data descriptor使用時(bit3)はローカルヘッダのサイズが0 → 中央ディレクトリから引く
  if ((flags & 0x08) && compSize === 0) {
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('EOCD not found');
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('central dir not found');
    compSize = buf.readUInt32LE(cdOffset + 20);
  }
  const data = buf.subarray(dataStart, dataStart + compSize);
  if (method === 0) return data;
  if (method === 8) return inflateRawSync(data);
  throw new Error(`unsupported compression method: ${method}`);
}
