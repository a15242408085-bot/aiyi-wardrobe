export const garmentTypes = [
  ['top', '上衣'],
  ['t-shirt', 'T 恤'], ['shirt', '衬衫'], ['blouse', '女式上衣'], ['sweater', '针织衫'],
  ['hoodie', '卫衣'], ['tank-top', '背心'], ['polo', 'Polo 衫'], ['pants', '长裤'],
  ['jeans', '牛仔裤'], ['shorts', '短裤'], ['skirt', '半裙'], ['dress', '连衣裙'],
  ['jacket', '外套'], ['coat', '大衣'], ['blazer', '西装外套'], ['cardigan', '开衫'], ['vest', '马甲'],
  ['shoes', '鞋'], ['sneakers', '运动鞋'], ['boots', '靴子'], ['sandals', '凉鞋'],
  ['bag', '包'], ['unknown', '其他'],
];
// Recognition confirmation uses the server vocabulary; legacy manual items may remain unknown.
export const recognitionGarmentTypes = garmentTypes.map(([value, label]) => [value === 'unknown' ? 'accessories' : value, label]);
export const garmentColors = [
  ['white', '白色'], ['black', '黑色'], ['gray', '灰色'], ['beige', '米色'], ['blue', '蓝色'],
  ['navy', '藏蓝'], ['brown', '棕色'], ['green', '绿色'], ['red', '红色'], ['pink', '粉色'],
  ['yellow', '黄色'], ['purple', '紫色'],
];
export const garmentTypeLabel = (type: string) => garmentTypes.find(([value]) => value === type)?.[1] || type;
export type TryOnCategory = 'top' | 'outerwear' | 'bottom' | 'shoes' | 'bag';
export const tryOnCategoryLabels: Record<TryOnCategory, string> = {top: '上衣', outerwear: '外套', bottom: '下装', shoes: '鞋', bag: '包'};
export function tryOnCategory(type: string): TryOnCategory | null {
  if (['t-shirt', 'shirt', 'blouse', 'sweater', 'tank-top', 'polo', 'top'].includes(type)) return 'top';
  if (['jacket', 'coat', 'hoodie', 'blazer', 'cardigan', 'vest'].includes(type)) return 'outerwear';
  if (['pants', 'jeans', 'shorts', 'skirt'].includes(type)) return 'bottom';
  if (['shoes', 'sneakers', 'boots', 'sandals'].includes(type)) return 'shoes';
  if (type === 'bag') return 'bag';
  return null;
}
