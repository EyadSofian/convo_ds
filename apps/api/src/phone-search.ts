/** Search aliases only. Identity matching and contact creation stay exact. */
export function phoneSearchPatterns(input: string): readonly string[] {
  const plain = input.replace(/[٠-٩۰-۹]/gu, (digit) => String(digit.charCodeAt(0) - (digit <= '٩' ? 0x660 : 0x6f0)));
  if (!/^[+\d\s().-]+$/.test(plain)) return [];
  const digits = plain.replace(/\D/g, '').replace(/^00/, '');
  if (digits.length < 3) return [];
  const national = digits.startsWith('201') ? `0${digits.slice(2)}` : digits;
  const international = /^01[0125]/.test(national) ? `2${national}` : digits;
  return [...new Set([national, international])].map((value) => `%${value}%`);
}

export function phoneSearchSql(column: string, parameter: string): string {
  return `regexp_replace(translate(${column},'٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','01234567890123456789'),'[^0-9]','','g') LIKE ANY(${parameter}::text[])`;
}
