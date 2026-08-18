/**
 * Calculate CRC16-CCITT Checksum for EMVCo QRIS
 * Standard: CCITT polynomial 0x1021 with initial value 0xFFFF
 */
export function calculateCRC16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Convert Static GoBiz QRIS String into Dynamic EMVCo QRIS with exact payable Amount
 * - Preserves all authentic merchant tags (00, 26, 51, 52, 53, 58, 59, 60, 61, 62, etc.)
 * - Replaces Tag 01 with "12" (Point of Initiation: Dynamic)
 * - Injects/Updates Tag 54 with exact amount string
 * - Recomputes Tag 63 (CRC16-CCITT) Checksum
 */
export function generateDynamicQRIS(staticTemplate: string, totalAmount: number): string {
  if (!staticTemplate || !staticTemplate.trim()) {
    throw new Error('BASE_QRIS_STRING_EMPTY');
  }

  let payload = staticTemplate.trim();

  // Strip existing Tag 63 (CRC) if present at end
  const idx63 = payload.indexOf('6304');
  if (idx63 !== -1) {
    payload = payload.substring(0, idx63);
  }

  // Parse EMVCo Tag-Length-Value (TLV) structure
  const tags: Array<{ id: string; length: number; value: string }> = [];
  let i = 0;
  while (i < payload.length) {
    const id = payload.substring(i, i + 2);
    const lenStr = payload.substring(i + 2, i + 4);
    const length = parseInt(lenStr, 10);
    if (isNaN(length)) break;
    const value = payload.substring(i + 4, i + 4 + length);
    tags.push({ id, length, value });
    i += 4 + length;
  }

  const amountStr = String(Math.round(totalAmount));
  let amountTagFound = false;

  // Transform Tag 01 to "12" (Dynamic), update Tag 54 if exists, and retain all other tags as-is
  const newTags = tags.map((t) => {
    if (t.id === '01') {
      return { id: '01', length: 2, value: '12' }; // Point of Initiation: 12 (Dynamic QR)
    }
    if (t.id === '54') {
      amountTagFound = true;
      return { id: '54', length: amountStr.length, value: amountStr };
    }
    return t;
  });

  // If Tag 54 does not exist in static template, insert it before Tag 58 (Country Code) or at appropriate position
  if (!amountTagFound) {
    const insertIdx = newTags.findIndex((t) => parseInt(t.id, 10) >= 58);
    const targetIdx = insertIdx !== -1 ? insertIdx : newTags.length;
    newTags.splice(targetIdx, 0, { id: '54', length: amountStr.length, value: amountStr });
  }

  // Reassemble TLV string
  let dynamicPayload = newTags
    .map((t) => {
      const lenStr = String(t.value.length).padStart(2, '0');
      return `${t.id}${lenStr}${t.value}`;
    })
    .join('');

  // Append Tag 63 Header and calculate 4-digit CRC16 Checksum
  dynamicPayload += '6304';
  const checksum = calculateCRC16(dynamicPayload);

  return `${dynamicPayload}${checksum}`;
}
