const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = socketIo(server);

// ========== 持久化目录 ==========
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const uploadDir = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + Buffer.from(file.originalname, 'latin1').toString('utf8'));
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ========== 数据初始化 ==========
let data = {
  users: {},
  friends: {},
  groups: [],
  messages: {},
  articles: [],
  publicArticles: [],
  fulltextArticles: [],
  intcomArticles: [],
  videos: [],
  friendRequests: [],
  worldMessages: []
};
if (fs.existsSync(DATA_FILE)) {
  data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  // 补全新字段
  if (!data.intcomArticles) data.intcomArticles = [];
  if (!data.videos) data.videos = [];
  if (!data.friendRequests) data.friendRequests = [];
  if (!data.worldMessages) data.worldMessages = [];
  Object.values(data.users).forEach(u => {
    if (!u.notifications) u.notifications = [];
    if (u.coins === undefined) u.coins = 0;
    if (!u.lastDailyClaim) u.lastDailyClaim = 0;
  });
}

function saveData() { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
function generateUniqueId() {
  let id;
  do { id = Math.floor(1000000000 + Math.random() * 9000000000).toString(); }
  while (Object.values(data.users).some(u => u.id === id));
  return id;
}
function getUserById(userId) { return Object.values(data.users).find(u => u.id === userId); }

// ========== 通用文件上传 ==========
app.post('/upload-file', upload.single('file'), (req, res) => {
  if (!req.file) return res.json({ error: '未选择文件' });
  res.json({ success: true, url: '/uploads/' + req.file.filename, originalName: req.file.originalname });
});

// ========== 用户注册/登录 ==========
app.post('/register', (req, res) => {
  const { nickname, password } = req.body;
  if (!nickname || !password) return res.json({ error: '昵称和密码不能为空' });
  if (data.users[nickname]) return res.json({ error: '该昵称已被注册' });
  const id = generateUniqueId();
  data.users[nickname] = {
    id, nickname, password, location: {}, image: null,
    role: 'user', notifications: [], coins: 0, lastDailyClaim: 0
  };
  if (!data.friends[nickname]) data.friends[nickname] = [];
  saveData();
  res.json({ id });
});

app.post('/login', (req, res) => {
  const { nickname, password } = req.body;
  const user = data.users[nickname];
  if (!user || user.password !== password) return res.json({ error: '昵称或密码错误' });
  const { password: _, ...safeUser } = user;
  res.json({ user: safeUser });
});

// ========== 注销账号 ==========
app.post('/delete-account', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '用户不存在' });
  const nickname = user.nickname;
  if (data.friends[nickname]) {
    data.friends[nickname].forEach(fn => {
      if (data.friends[fn]) data.friends[fn] = data.friends[fn].filter(n => n !== nickname);
    });
    delete data.friends[nickname];
  }
  data.friendRequests = data.friendRequests.filter(r => r.fromUserId !== userId && r.toUserId !== userId);
  data.groups.forEach(g => {
    if (g.members.includes(userId)) {
      g.members = g.members.filter(m => m !== userId);
      if (g.ownerId === userId && g.members.length > 0) g.ownerId = g.members[0];
    }
  });
  data.groups = data.groups.filter(g => g.members.length > 0);
  data.articles = data.articles.filter(a => a.authorId !== userId);
  data.fulltextArticles = data.fulltextArticles.filter(a => a.authorId !== userId);
  data.intcomArticles = data.intcomArticles.filter(a => a.authorId !== userId);
  data.videos = data.videos.filter(v => v.authorId !== userId);
  delete data.users[nickname];
  saveData();
  res.json({ success: true });
});

// ========== 每日签到 ==========
app.post('/daily-claim', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  const now = Date.now();
  if (now - user.lastDailyClaim < 86400000) return res.json({ error: '请24小时后再领取' });
  user.coins = (user.coins || 0) + 1;
  user.lastDailyClaim = now;
  saveData();
  res.json({ coins: user.coins });
});

// ========== 好友管理 ==========
app.post('/friend/remove', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  const { friendName } = req.body;
  if (!data.friends[user.nickname]) return res.json({ error: '好友列表为空' });
  const idx = data.friends[user.nickname].indexOf(friendName);
  if (idx === -1) return res.json({ error: '该用户不是好友' });
  data.friends[user.nickname].splice(idx, 1);
  if (data.friends[friendName]) data.friends[friendName] = data.friends[friendName].filter(n => n !== user.nickname);
  saveData();
  res.json({ success: true });
});

// ========== 权限提升（管理员/站主） ==========
app.post('/promote', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  const { password } = req.body;
  if (password === '9999') { user.role = 'admin'; saveData(); return res.json({ role: 'admin' }); }
  else if (password === '0000') { user.role = 'superadmin'; saveData(); return res.json({ role: 'superadmin' }); }
  else return res.json({ error: '密码错误' });
});

// 管理员/站主可查看所有用户
app.get('/users/list', (req, res) => {
  const user = getUserById(req.headers['x-user-id']);
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) return res.json({ error: '权限不足' });
  res.json({ users: Object.values(data.users).map(u => ({ id: u.id, nickname: u.nickname })) });
});

// 站主可查看管理员列表并撤销
app.get('/admin/list', (req, res) => {
  const user = getUserById(req.headers['x-user-id']);
  if (!user || user.role !== 'superadmin') return res.json({ error: '权限不足' });
  const admins = Object.values(data.users).filter(u => u.role === 'admin').map(u => ({ id: u.id, nickname: u.nickname }));
  res.json({ admins });
});
app.post('/admin/demote', (req, res) => {
  const user = getUserById(req.headers['x-user-id']);
  if (!user || user.role !== 'superadmin') return res.json({ error: '权限不足' });
  const target = getUserById(req.body.targetUserId);
  if (!target) return res.json({ error: '用户不存在' });
  target.role = 'user';
  saveData();
  res.json({ success: true });
});

// ========== 个人精文报（公开，无需审核） ==========
app.get('/public-feed', (req, res) => {
  const sort = req.query.sort || 'latest';
  let arts = [...data.articles];
  if (sort === 'hot') arts.sort((a, b) => (b.likes + b.favorites) - (a.likes + a.favorites));
  else arts.sort((a, b) => b.timestamp - a.timestamp);
  res.json(arts);
});

app.post('/publish', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  const { title, tags, files } = req.body;
  let tagArr = tags;
  if (typeof tags === 'string') tagArr = tags.split(',').map(t => t.trim()).filter(Boolean);
  if (!tagArr || tagArr.length === 0) return res.json({ error: '请至少选择一个标签' });
  if (!title) return res.json({ error: '标题不能为空' });
  if (!files || files.length === 0) return res.json({ error: '请至少上传一个PDF或Word文件' });
  const article = {
    id: generateUniqueId(), authorId: userId, author: user.nickname, title, content: '', tags: tagArr,
    files: files, likes: 0, favorites: 0, coins: 0, recommends: 0,
    likedBy: [], favoritedBy: [], coinedBy: [], timestamp: Date.now()
  };
  data.articles.push(article);
  saveData();
  res.json({ success: true });
});

// 点赞/收藏/投币 + 通知
app.post('/articles/:id/like', (req, res) => {
  const userId = req.headers['x-user-id'];
  const article = data.articles.find(a => a.id === req.params.id) || data.fulltextArticles.find(a => a.id === req.params.id);
  if (!article) return res.json({ error: '文章不存在' });
  if (!article.likedBy) article.likedBy = [];
  if (article.likedBy.includes(userId)) return res.json({ error: '已经点过赞了' });
  article.likes = (article.likes || 0) + 1;
  article.likedBy.push(userId);
  // 通知作者
  const author = getUserById(article.authorId);
  if (author && author.id !== userId) {
    const liker = getUserById(userId);
    author.notifications.push({ message: `${liker?.nickname || '某同志'} 赞了你的文章《${article.title}》`, timestamp: Date.now() });
  }
  saveData(); res.json({ success: true });
});
app.post('/articles/:id/favorite', (req, res) => {
  const userId = req.headers['x-user-id'];
  const article = data.articles.find(a => a.id === req.params.id) || data.fulltextArticles.find(a => a.id === req.params.id);
  if (!article) return res.json({ error: '文章不存在' });
  if (!article.favoritedBy) article.favoritedBy = [];
  if (article.favoritedBy.includes(userId)) return res.json({ error: '已经收藏过了' });
  article.favorites = (article.favorites || 0) + 1;
  article.favoritedBy.push(userId);
  const author = getUserById(article.authorId);
  if (author && author.id !== userId) {
    const favoriter = getUserById(userId);
    author.notifications.push({ message: `${favoriter?.nickname || '某同志'} 收藏了你的文章《${article.title}》`, timestamp: Date.now() });
  }
  saveData(); res.json({ success: true });
});
app.post('/articles/:id/coin', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  if (!user.coins || user.coins < 1) return res.json({ error: '硬币不足' });
  const article = data.articles.find(a => a.id === req.params.id) || data.fulltextArticles.find(a => a.id === req.params.id);
  if (!article) return res.json({ error: '文章不存在' });
  if (!article.coinedBy) article.coinedBy = [];
  if (article.coinedBy.includes(userId)) return res.json({ error: '已经投过币了' });
  user.coins -= 1;
  article.coins = (article.coins || 0) + 1;
  article.coinedBy.push(userId);
  const author = getUserById(article.authorId);
  if (author && author.id !== userId) {
    author.notifications.push({ message: `${user.nickname} 给你投了一枚硬币：${article.title}`, timestamp: Date.now() });
  }
  saveData(); res.json({ success: true });
});

// ========== 其他文集（仅管理员/站主可发布，无密码） ==========
app.get('/public-articles', (req, res) => res.json(data.publicArticles || []));
app.post('/publish-public', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  if (user.role !== 'admin' && user.role !== 'superadmin') return res.json({ error: '仅管理员或站主可在此刊登' });
  const { title, tags, files } = req.body;  // 无密码
  let tagArr = tags;
  if (typeof tags === 'string') tagArr = tags.split(',').map(t => t.trim()).filter(Boolean);
  if (!tagArr || tagArr.length === 0) return res.json({ error: '请至少选择一个标签' });
  if (!title) return res.json({ error: '标题不能为空' });
  if (!files || files.length === 0) return res.json({ error: '请至少上传一个PDF或Word文件' });
  const article = {
    id: generateUniqueId(), author: user.nickname, authorId: userId, title, content: '', tags: tagArr,
    files: files, timestamp: Date.now(), likedBy: [], favoritedBy: [], coinedBy: []
  };
  data.publicArticles.push(article);
  saveData();
  res.json({ success: true });
});

// ========== 全文区（仅管理员/站主，无密码） ==========
app.get('/fulltext-articles', (req, res) => res.json(data.fulltextArticles || []));
app.post('/publish-fulltext', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) return res.json({ error: '仅管理员或站主可在此刊登' });
  const { title, tags, files } = req.body;
  let tagArr = tags;
  if (typeof tags === 'string') tagArr = tags.split(',').map(t => t.trim()).filter(Boolean);
  if (!tagArr || tagArr.length === 0) return res.json({ error: '请至少选择一个标签' });
  if (!title) return res.json({ error: '标题不能为空' });
  if (!files || files.length === 0) return res.json({ error: '请至少上传一个PDF或Word文件' });
  data.fulltextArticles.push({
    id: generateUniqueId(), author: user.nickname, title, content: '', tags: tagArr,
    files: files, recommends: 0, timestamp: Date.now()
  });
  saveData();
  res.json({ success: true });
});

// ========== 视频区 ==========
app.post('/upload-video', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  const { title, url, desc, fileUrl } = req.body;
  if (!title) return res.json({ error: '标题不能为空' });
  if (!url && !fileUrl) return res.json({ error: '请提供视频链接或上传视频文件' });
  const video = {
    id: generateUniqueId(), author: user.nickname, authorId: userId, title,
    url: url || fileUrl, isUploadedFile: !!fileUrl, desc: desc || '',
    likes: 0, favorites: 0, comments: [], likedBy: [], favoritedBy: [], timestamp: Date.now()
  };
  data.videos.push(video);   // 直接发布，无需审核
  saveData();
  res.json({ success: true });
});
app.get('/videos', (req, res) => {
  let vids = data.videos || [];
  const sort = req.query.sort || 'latest';
  if (sort === 'hot') vids.sort((a, b) => (b.likes + b.favorites) - (a.likes + a.favorites));
  else vids.sort((a, b) => b.timestamp - a.timestamp);
  res.json(vids);
});
app.get('/videos/:id/comments', (req, res) => {
  const video = data.videos.find(v => v.id === req.params.id);
  if (!video) return res.json({ error: '视频不存在' });
  res.json({ comments: video.comments || [] });
});
app.post('/videos/:id/comment', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  const video = data.videos.find(v => v.id === req.params.id);
  if (!video) return res.json({ error: '视频不存在' });
  const { text } = req.body;
  if (!text) return res.json({ error: '评论不能为空' });
  video.comments.push({ author: user.nickname, text, timestamp: Date.now() });
  // 通知视频作者
  const author = getUserById(video.authorId);
  if (author && author.id !== userId) {
    author.notifications.push({ message: `${user.nickname} 评论了你的视频《${video.title}》`, timestamp: Date.now() });
  }
  saveData();
  res.json({ success: true });
});
app.post('/videos/:id/like', (req, res) => {
  const userId = req.headers['x-user-id'];
  const video = data.videos.find(v => v.id === req.params.id);
  if (!video) return res.json({ error: '视频不存在' });
  if (!video.likedBy) video.likedBy = [];
  if (video.likedBy.includes(userId)) return res.json({ error: '已经点过赞了' });
  video.likes = (video.likes || 0) + 1;
  video.likedBy.push(userId);
  const author = getUserById(video.authorId);
  if (author && author.id !== userId) {
    const liker = getUserById(userId);
    author.notifications.push({ message: `${liker?.nickname || '某同志'} 赞了你的视频《${video.title}》`, timestamp: Date.now() });
  }
  saveData(); res.json({ success: true });
});
app.post('/videos/:id/favorite', (req, res) => {
  const userId = req.headers['x-user-id'];
  const video = data.videos.find(v => v.id === req.params.id);
  if (!video) return res.json({ error: '视频不存在' });
  if (!video.favoritedBy) video.favoritedBy = [];
  if (video.favoritedBy.includes(userId)) return res.json({ error: '已经收藏过了' });
  video.favorites = (video.favorites || 0) + 1;
  video.favoritedBy.push(userId);
  const author = getUserById(video.authorId);
  if (author && author.id !== userId) {
    const favoriter = getUserById(userId);
    author.notifications.push({ message: `${favoriter?.nickname || '某同志'} 收藏了你的视频《${video.title}》`, timestamp: Date.now() });
  }
  saveData(); res.json({ success: true });
});

// ========== 国际共运（管理员/站主，密码保留？要求未提，保留原样，但允许无密码？不要求去掉，所以保留密码） ==========
app.get('/intcom-articles', (req, res) => res.json(data.intcomArticles || []));
app.post('/publish-intcom', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) return res.json({ error: '权限不足' });
  const { title, content, tags, password } = req.body;  // 仍要求密码
  if (password !== '世界人民大团结') return res.json({ error: '密码错误' });
  let tagArr = tags;
  if (typeof tags === 'string') tagArr = tags.split(',').map(t => t.trim()).filter(Boolean);
  if (!tagArr || tagArr.length === 0) return res.json({ error: '请至少选择一个标签' });
  data.intcomArticles.push({
    id: generateUniqueId(), author: user.nickname, title, content, tags: tagArr,
    recommends: 0, timestamp: Date.now()
  });
  saveData();
  res.json({ success: true });
});
app.post('/intcom-articles/:id/recommend', (req, res) => {
  const article = data.intcomArticles.find(a => a.id === req.params.id);
  if (!article) return res.json({ error: '文章不存在' });
  article.recommends = (article.recommends || 0) + 1;
  const author = getUserById(article.authorId);
  if (author && author.id !== req.headers['x-user-id']) {
    const recommender = getUserById(req.headers['x-user-id']);
    author.notifications.push({ message: `${recommender?.nickname || '某同志'} 推荐了你的文章《${article.title}》`, timestamp: Date.now() });
  }
  saveData(); res.json({ success: true });
});

// ========== 个人主页/位置/头像 ==========
app.post('/updateLocation', (req, res) => {
  const { id, location } = req.body;
  const user = getUserById(id);
  if (!user) return res.json({ error: '用户不存在' });
  user.location = location;
  saveData();
  res.json({ success: true });
});
app.post('/upload-image', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  user.image = req.body.image;
  saveData();
  res.json({ success: true });
});
app.get('/user/:id', (req, res) => {
  const user = Object.values(data.users).find(u => u.id === req.params.id);
  if (!user) return res.json({ error: '用户不存在' });
  res.json({ id: user.id, nickname: user.nickname, location: user.location, image: user.image || null });
});

// ========== 群组管理 ==========
app.get('/group/:id/members', (req, res) => {
  const group = data.groups.find(g => g.id === req.params.id);
  if (!group || !group.members.includes(req.headers['x-user-id'])) return res.json({ error: '无权限' });
  const members = group.members.map(mid => {
    const u = getUserById(mid);
    return u ? { id: u.id, nickname: u.nickname } : { id: mid, nickname: '未知' };
  });
  res.json({ members });
});
app.post('/group/:id/invite', (req, res) => {
  const userId = req.headers['x-user-id'];
  const group = data.groups.find(g => g.id === req.params.id);
  if (!group || group.ownerId !== userId) return res.json({ error: '只有群主可邀请' });
  const target = getUserById(req.body.targetUserId);
  if (!target) return res.json({ error: '用户不存在' });
  if (group.members.includes(target.id)) return res.json({ error: '已在群中' });
  group.members.push(target.id);
  saveData();
  const targetSocket = findSocketByUserId(target.id);
  if (targetSocket) targetSocket.emit('updateGroups', data.groups.filter(g => g.members.includes(target.id)));
  res.json({ success: true });
});
app.post('/group/:id/kick', (req, res) => {
  const userId = req.headers['x-user-id'];
  const group = data.groups.find(g => g.id === req.params.id);
  if (!group || group.ownerId !== userId) return res.json({ error: '只有群主可踢人' });
  const targetId = req.body.targetUserId;
  if (targetId === group.ownerId) return res.json({ error: '不能踢出群主' });
  const index = group.members.indexOf(targetId);
  if (index === -1) return res.json({ error: '该用户不在群中' });
  group.members.splice(index, 1);
  saveData();
  const targetSocket = findSocketByUserId(targetId);
  if (targetSocket) targetSocket.emit('updateGroups', data.groups.filter(g => g.members.includes(targetId)));
  res.json({ success: true });
});
app.get('/group/:id/files', (req, res) => {
  const group = data.groups.find(g => g.id === req.params.id);
  if (!group) return res.json({ error: '群不存在' });
  if (!group.files) group.files = [];
  res.json({ files: group.files });
});
app.post('/group/upload', upload.single('file'), (req, res) => {
  const userId = req.headers['x-user-id'];
  const group = data.groups.find(g => g.id === req.body.groupId);
  if (!group || !group.members.includes(userId)) return res.json({ error: '无权限' });
  if (!req.file) return res.json({ error: '未上传文件' });
  const fileInfo = {
    originalName: req.file.originalname, filename: req.file.filename,
    url: '/uploads/' + req.file.filename, timestamp: Date.now(), uploaderId: userId
  };
  if (!group.files) group.files = [];
  group.files.push(fileInfo);
  saveData();
  group.members.forEach(mid => {
    const s = findSocketByUserId(mid);
    if (s) s.emit('groupFilesUpdated', req.body.groupId);
  });
  res.json({ success: true });
});

// ========== 信箱（包含通知、好友请求、好友列表） ==========
app.get('/mailbox', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  const requests = data.friendRequests.filter(r => r.toUserId === userId && r.status === 'pending').map(r => ({
    id: r.id, fromId: r.fromUserId, fromName: getUserById(r.fromUserId)?.nickname || '未知'
  }));
  const friendNames = data.friends[user.nickname] || [];
  const friends = friendNames.map(name => ({ id: data.users[name]?.id || name, name }));
  const notifications = (user.notifications || []).slice(-30).reverse();  // 最近30条
  res.json({ requests, friends, notifications });
});
app.post('/friend/accept', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  const request = data.friendRequests.find(r => r.id === req.body.requestId && r.toUserId === userId);
  if (!request) return res.json({ error: '请求不存在' });
  request.status = 'accepted';
  const friendUser = getUserById(request.fromUserId);
  if (!friendUser) return res.json({ error: '对方不存在' });
  if (!data.friends[user.nickname]) data.friends[user.nickname] = [];
  data.friends[user.nickname].push(friendUser.nickname);
  if (!data.friends[friendUser.nickname]) data.friends[friendUser.nickname] = [];
  data.friends[friendUser.nickname].push(user.nickname);
  saveData();
  const fromSocket = findSocketByUserId(request.fromUserId);
  if (fromSocket) fromSocket.emit('refreshFriends');
  io.to(userId).emit('refreshFriends');
  res.json({ success: true });
});
app.post('/friend/reject', (req, res) => {
  const request = data.friendRequests.find(r => r.id === req.body.requestId && r.toUserId === req.headers['x-user-id']);
  if (!request) return res.json({ error: '请求不存在' });
  request.status = 'rejected';
  saveData();
  res.json({ success: true });
});

// ========== Socket.IO（世界聊天+好友+群组） ==========
io.on('connection', (socket) => {
  let currentNickname = '';
  let currentId = '';
  socket.join('world');

  socket.on('login', (nickname, userId) => {
    currentNickname = nickname;
    currentId = userId;
    socket.join(userId);
    sendFriendList(socket, nickname);
    socket.emit('updateGroups', data.groups.filter(g => g.members.includes(userId)).map(g => ({
      id: g.id, name: g.name, members: g.members, ownerId: g.ownerId
    })));
    socket.emit('worldHistory', data.worldMessages || []);
  });

  socket.on('requestFriend', (targetId) => {
    if (targetId === currentId) return socket.emit('errorMsg', '不能添加自己');
    const targetUser = getUserById(targetId);
    if (!targetUser) return socket.emit('errorMsg', '该ID不存在');
    const existing = data.friendRequests.find(r => r.fromUserId === currentId && r.toUserId === targetId && r.status === 'pending');
    if (existing) return socket.emit('errorMsg', '已发送申请');
    data.friendRequests.push({ id: generateUniqueId(), fromUserId: currentId, toUserId: targetId, status: 'pending', timestamp: Date.now() });
    saveData();
    const targetSocket = findSocketByUserId(targetId);
    if (targetSocket) targetSocket.emit('refreshFriends');
    socket.emit('errorMsg', '申请已发送');
  });

  socket.on('getMyFriends', () => {
    const friendNames = data.friends[currentNickname] || [];
    socket.emit('updateFriends', friendNames.map(name => ({ id: data.users[name]?.id || name, name })));
  });

  socket.on('createGroup', ({ name, members }) => {
    members.push(currentId);
    members = [...new Set(members)];
    const group = { id: generateUniqueId(), name, members, ownerId: currentId };
    data.groups.push(group);
    saveData();
    members.forEach(mid => {
      const s = findSocketByUserId(mid);
      if (s) s.emit('updateGroups', data.groups.filter(g => g.members.includes(mid)).map(g => ({
        id: g.id, name: g.name, members: g.members, ownerId: g.ownerId
      })));
    });
  });

  socket.on('sendMessage', ({ targetType, targetId, content }) => {
    const msg = { from: currentNickname, targetType, targetId, content, timestamp: Date.now() };
    const key = targetType + '-' + targetId;
    if (!data.messages[key]) data.messages[key] = [];
    data.messages[key].push(msg);
    saveData();
    if (targetType === 'friend') {
      const friendUser = getUserById(targetId);
      if (friendUser) {
        const targetSocket = findSocketByNickname(friendUser.nickname);
        if (targetSocket) targetSocket.emit('newMessage', msg);
        socket.emit('newMessage', msg);
      }
    } else if (targetType === 'group') {
      const group = data.groups.find(g => g.id === targetId);
      if (group) {
        group.members.forEach(mid => {
          const s = findSocketByUserId(mid);
          if (s) s.emit('newMessage', msg);
        });
      }
    }
  });

  socket.on('getHistory', ({ type, id }) => {
    socket.emit('history', data.messages[type + '-' + id] || []);
  });

  socket.on('worldMessage', (content) => {
    if (!currentNickname) return;
    const msg = { from: currentNickname, content, timestamp: Date.now() };
    data.worldMessages.push(msg);
    if (data.worldMessages.length > 100) data.worldMessages.shift();
    saveData();
    io.to('world').emit('worldMessage', msg);
  });

  socket.on('disconnect', () => socket.leave('world'));
});

function sendFriendList(socket, nickname) {
  const friendNames = data.friends[nickname] || [];
  socket.emit('updateFriends', friendNames.map(name => ({ id: data.users[name]?.id || name, name })));
}

function findSocketByNickname(nickname) {
  for (let [id, s] of io.of('/').sockets) { if (s.currentNickname === nickname) return s; }
  return null;
}
function findSocketByUserId(userId) {
  for (let [id, s] of io.of('/').sockets) { if (s.currentId === userId) return s; }
  return null;
}

io.use((socket, next) => {
  socket.currentNickname = '';
  socket.currentId = '';
  const originalOn = socket.on.bind(socket);
  socket.on = (event, handler) => {
    if (event === 'login') return originalOn(event, (nickname, userId) => {
      socket.currentNickname = nickname; socket.currentId = userId; handler(nickname, userId);
    });
    return originalOn(event, handler);
  };
  next();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ 服务器已启动，端口 ${PORT}`));