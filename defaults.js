// 所有脚本共用的默认设置（background / content / options 都会加载）
self.XRC_DEFAULTS = {
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.8,
  maxLen: 25, // 回复最大字数
  persona: '你是一个友善、有见地的科技爱好者。回复要具体、真诚，针对帖子内容给出观点或追问，避免空洞的夸奖。',
  keywords: '',
  autoDraft: true,
  scrollSpeed: 2,
  maxDrafts: 20, // 面板里待处理草稿上限
  stopAtDrafts: 10, // 待处理草稿达到这个数时自动停止浏览，0 = 不停止
  dailyLimit: 30, // 每日回复上限
  batchMin: 30, // 批量发送间隔（秒）
  batchMax: 90,
  autoLike: true, // 回复成功后自动给原帖点赞
};
