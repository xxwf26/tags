// pm2 进程配置：生产实例，端口 3323，绑 0.0.0.0 供局域网访问
// 用法：pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [{
    name: 'style-atlas',
    cwd: __dirname,
    script: 'dist/main.js',
    env: { NODE_ENV: 'production', PORT: '3323' },
    max_memory_restart: '1G',
    autorestart: true,
    max_restarts: 10,
  }],
};
