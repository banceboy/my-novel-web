/**
 * 网文发布平台清单：新建作品时标注这本书将来发到哪个平台，
 * 为后续按平台的格式/功能预留。id 存库（稳定、可扩展），zh/en 是显示名。
 */
export type PublishingPlatform = {
  id: string
  zh: string
  en: string
}

export const PUBLISHING_PLATFORMS: readonly PublishingPlatform[] = [
  { id: 'qidian', zh: '起点读书', en: 'Qidian' },
  { id: 'fanqie', zh: '番茄小说', en: 'Tomato Novel' },
  { id: 'jinjiang', zh: '晋江文学城', en: 'Jinjiang' },
  { id: 'qimao', zh: '七猫免费小说', en: 'Qimao' },
  { id: 'zongheng', zh: '纵横中文网', en: 'Zongheng' },
  { id: '17k', zh: '17K小说网', en: '17K' },
  { id: 'feilu', zh: '飞卢小说网', en: 'Feilu' },
  { id: 'shuqi', zh: '书旗小说', en: 'Shuqi' },
  { id: 'qqreading', zh: 'QQ阅读', en: 'QQ Reading' },
  { id: 'zhangyue', zh: '掌阅', en: 'iReader' },
  { id: 'douban', zh: '豆瓣阅读', en: 'Douban Read' },
  { id: 'changpei', zh: '长佩文学', en: 'Changpei' },
  { id: 'ciweimao', zh: '刺猬猫阅读', en: 'Ciweimao' },
] as const
