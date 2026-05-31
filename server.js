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

// ========== 数据与文件目录（支持 Railway Volume） ==========
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const uploadDir = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));

// ========== 健康检查（必须保留） ==========
app.get('/health', (req, res) => res.status(200).send('OK'));

// ========== 显式首页 ==========
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ========== 初始化数据 ==========
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
  worldMessages: [],
  pendingArticles: [],
  pendingVideos: [],
  reviewApplications: []
};
if (fs.existsSync(DATA_FILE)) {
  data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  // 补全新字段
  if (!data.intcomArticles) data.intcomArticles = [];
  if (!data.videos) data.videos = [];
  if (!data.friendRequests) data.friendRequests = [];
  if (!data.worldMessages) data.worldMessages = [];
  if (!data.pendingArticles) data.pendingArticles = [];
  if (!data.pendingVideos) data.pendingVideos = [];
  if (!data.reviewApplications) data.reviewApplications = [];
  Object.values(data.users).forEach(u => {
    if (!u.notifications) u.notifications = [];
    if (u.coins === undefined) u.coins = 0;
    if (!u.lastDailyClaim) u.lastDailyClaim = 0;
  });
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function generateUniqueId() {
  let id;
  do {
    id = Math.floor(1000000000 + Math.random() * 9000000000).toString();
  } while (Object.values(data.users).some(u => u.id === id));
  return id;
}

function getUserById(userId) {
  return Object.values(data.users).find(u => u.id === userId);
}

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
    data.friends[nickname].forEach(friendName => {
      if (data.friends[friendName]) {
        data.friends[friendName] = data.friends[friendName].filter(n => n !== nickname);
      }
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
  data.pendingArticles = data.pendingArticles.filter(a => a.authorId !== userId);
  data.pendingVideos = data.pendingVideos.filter(v => v.authorId !== userId);
  delete data.users[nickname];
  saveData();
  res.json({ success: true });
});

// ========== 每日签到领币 ==========
app.post('/daily-claim', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  const now = Date.now();
  if (now - user.lastDailyClaim < 24 * 60 * 60 * 1000) {
    return res.json({ error: '请24小时后再领取' });
  }
  user.coins = (user.coins || 0) + 1;
  user.lastDailyClaim = now;
  saveData();
  res.json({ coins: user.coins });
});

// ========== 好友管理（添加/删除/申请） ==========
app.post('/friend/remove', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  const { friendName } = req.body;
  if (!data.friends[user.nickname]) return res.json({ error: '好友列表为空' });
  const index = data.friends[user.nickname].indexOf(friendName);
  if (index === -1) return res.json({ error: '该用户不是好友' });
  data.friends[user.nickname].splice(index, 1);
  if (data.friends[friendName]) {
    data.friends[friendName] = data.friends[friendName].filter(n => n !== user.nickname);
  }
  saveData();
  res.json({ success: true });
});

// ========== 审核员申请 ==========
app.post('/apply-reviewer', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  if (user.role !== 'user') return res.json({ error: '权限不足' });
  const existing = data.reviewApplications.find(a => a.userId === userId && a.status === 'pending');
  if (existing) return res.json({ error: '已有待处理的申请' });
  data.reviewApplications.push({
    id: generateUniqueId(),
    userId: userId,
    nickname: user.nickname,
    status: 'pending',
    timestamp: Date.now()
  });
  saveData();
  res.json({ success: true });
});

app.get('/review-applications', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) return res.json({ error: '权限不足' });
  res.json({ applications: data.reviewApplications.filter(a => a.status === 'pending') });
});

app.post('/review-application/:id', (req, res) => {
  const userId = req.headers['x-user-id'];
  const admin = getUserById(userId);
  if (!admin || (admin.role !== 'admin' && admin.role !== 'superadmin')) return res.json({ error: '权限不足' });
  const app = data.reviewApplications.find(a => a.id === req.params.id);
  if (!app) return res.json({ error: '申请不存在' });
  const { action } = req.body; // 'accept' or 'reject'
  if (action === 'accept') {
    const targetUser = getUserById(app.userId);
    if (targetUser) targetUser.role = 'reviewer';
    app.status = 'accepted';
  } else if (action === 'reject') {
    app.status = 'rejected';
  }
  saveData();
  res.json({ success: true });
});

// ========== 个人精文报（公开，所有人可见） ==========
app.get('/public-feed', (req, res) => {
  const sort = req.query.sort || 'latest';
  let articles = [...data.articles];
  if (sort === 'hot') {
    articles.sort((a, b) => (b.likes + b.favorites) - (a.likes + a.favorites));
  } else {
    articles.sort((a, b) => b.timestamp - a.timestamp);
  }
  res.json(articles);
});

app.post('/publish', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  const { title, content, tags } = req.body;
  if (!tags || tags.length === 0) return res.json({ error: '请至少选择一个标签' });
  const article = {
    id: generateUniqueId(),
    authorId: userId,
    author: user.nickname,
    title,
    content,
    tags,
    likes: 0,
    favorites: 0,
    coins: 0,
    recommends: 0,
    likedBy: [],
    favoritedBy: [],
    coinedBy: [],
    timestamp: Date.now()
  };
  data.articles.push(article);
  saveData();
  res.json({ success: true });
});

// 点赞/收藏/投币（每人限制一次）
app.post('/articles/:id/like', (req, res) => {
  const userId = req.headers['x-user-id'];
  const article = data.articles.find(a => a.id === req.params.id) || data.fulltextArticles.find(a => a.id === req.params.id);
  if (!article) return res.json({ error: '文章不存在' });
  if (!article.likedBy) article.likedBy = [];
  if (article.likedBy.includes(userId)) return res.json({ error: '已经点过赞了' });
  article.likes = (article.likes || 0) + 1;
  article.likedBy.push(userId);
  saveData();
  res.json({ success: true });
});
app.post('/articles/:id/favorite', (req, res) => {
  const userId = req.headers['x-user-id'];
  const article = data.articles.find(a => a.id === req.params.id) || data.fulltextArticles.find(a => a.id === req.params.id);
  if (!article) return res.json({ error: '文章不存在' });
  if (!article.favoritedBy) article.favoritedBy = [];
  if (article.favoritedBy.includes(userId)) return res.json({ error: '已经收藏过了' });
  article.favorites = (article.favorites || 0) + 1;
  article.favoritedBy.push(userId);
  saveData();
  res.json({ success: true });
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
  saveData();
  res.json({ success: true });
});

// ========== 其他文集（需审核） ==========
app.post('/publish-public', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  const { title, content, password, tags } = req.body;
  if (password !== '12321') return res.json({ error: '密码错误' });
  if (!tags || tags.length === 0) return res.json({ error: '请至少选择一个标签' });
  const article = {
    id: generateUniqueId(),
    author: user.nickname,
    authorId: userId,
    title,
    content,
    tags,
    timestamp: Date.now(),
    likedBy: [], favoritedBy: [], coinedBy: []
  };
  data.pendingArticles.push(article);
  saveData();
  res.json({ success: true, pending: true });
});

app.get('/public-articles', (req, res) => res.json(data.publicArticles || []));

// ========== 视频区（需审核） ==========
app.post('/upload-video', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  const { title, url, desc } = req.body;
  if (!title || !url) return res.json({ error: '标题和链接不能为空' });
  const video = {
    id: generateUniqueId(),
    author: user.nickname,
    authorId: userId,
    title,
    url,
    desc: desc || '',
    likes: 0,
    favorites: 0,
    comments: [],
    likedBy: [],
    favoritedBy: [],
    timestamp: Date.now()
  };
  data.pendingVideos.push(video);
  saveData();
  res.json({ success: true, pending: true });
});

// 审核列表（审核员可见）
app.get('/pending-list', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user || user.role !== 'reviewer') return res.json({ error: '权限不足' });
  res.json({
    articles: data.pendingArticles.filter(a => a.authorId !== userId),
    videos: data.pendingVideos.filter(v => v.authorId !== userId)
  });
});

// 审核通过
app.post('/approve/:type/:id', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user || user.role !== 'reviewer') return res.json({ error: '权限不足' });
  const { type, id } = req.params;
  if (type === 'article') {
    const index = data.pendingArticles.findIndex(a => a.id === id);
    if (index === -1) return res.json({ error: '文章不存在' });
    const article = data.pendingArticles.splice(index, 1)[0];
    data.publicArticles.push(article);
  } else if (type === 'video') {
    const index = data.pendingVideos.findIndex(v => v.id === id);
    if (index === -1) return res.json({ error: '视频不存在' });
    const video = data.pendingVideos.splice(index, 1)[0];
    data.videos.push(video);
  }
  saveData();
  res.json({ success: true });
});

// 审核拒绝
app.post('/reject/:type/:id', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user || user.role !== 'reviewer') return res.json({ error: '权限不足' });
  const { type, id } = req.params;
  if (type === 'article') {
    data.pendingArticles = data.pendingArticles.filter(a => a.id !== id);
  } else if (type === 'video') {
    data.pendingVideos = data.pendingVideos.filter(v => v.id !== id);
  }
  saveData();
  res.json({ success: true });
});

// ========== 全文区/国际共运（不变） ==========
app.get('/fulltext-articles', (req, res) => res.json(data.fulltextArticles || []));
app.post('/publish-fulltext', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) return res.json({ error: '权限不足' });
  const { title, content, tags, password } = req.body;
  if (password !== '8888') return res.json({ error: '密码错误' });
  if (!tags || tags.length === 0) return res.json({ error: '请至少选择一个标签' });
  data.fulltextArticles.push({
    id: generateUniqueId(), author: user.nickname, title, content, tags,
    recommends: 0, timestamp: Date.now()
  });
  saveData();
  res.json({ success: true });
});

app.get('/intcom-articles', (req, res) => res.json(data.intcomArticles || []));
app.post('/publish-intcom', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) return res.json({ error: '权限不足' });
  const { title, content, tags, password } = req.body;
  if (password !== '世界人民大团结') return res.json({ error: '密码错误' });
  if (!tags || tags.length === 0) return res.json({ error: '请至少选择一个标签' });
  data.intcomArticles.push({
    id: generateUniqueId(), author: user.nickname, title, content, tags,
    recommends: 0, timestamp: Date.now()
  });
  saveData();
  res.json({ success: true });
});

// ========== 个人主页、权限等原有API（保留） ==========
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

app.post('/promote', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  const { password } = req.body;
  if (password === '9999') { user.role = 'admin'; saveData(); return res.json({ role: 'admin' }); }
  else if (password === '0000') { user.role = 'superadmin'; saveData(); return res.json({ role: 'superadmin' }); }
  else return res.json({ error: '密码错误' });
});

app.get('/users/list', (req, res) => {
  const user = getUserById(req.headers['x-user-id']);
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) return res.json({ error: '权限不足' });
  res.json({ users: Object.values(data.users).map(u => ({ id: u.id, nickname: u.nickname })) });
});

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

// ========== 信箱 ==========
app.get('/mailbox', (req, res) => {
  const userId = req.headers['x-user-id'];
  const user = getUserById(userId);
  if (!user) return res.json({ error: '未登录' });
  const requests = data.friendRequests.filter(r => r.toUserId === userId && r.status === 'pending').map(r => ({
    id: r.id, fromId: r.fromUserId, fromName: getUserById(r.fromUserId)?.nickname || '未知'
  }));
  const friendNames = data.friends[user.nickname] || [];
  const friends = friendNames.map(name => ({ id: data.users[name]?.id || name, name }));
  const notifications = (user.notifications || []).slice(-20).reverse();
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

// ========== Socket.IO ==========
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

  socket.on('disconnect', () => {
    socket.leave('world');
  });
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 服务器已成功启动，端口 ${PORT}，健康检查 /health 可用`);
});