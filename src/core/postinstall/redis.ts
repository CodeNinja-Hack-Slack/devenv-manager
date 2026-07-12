import path from 'node:path';
import type { InstallStep } from '../../types.js';

// ============================================================================
// Redis 安装步骤：注册/启动系统服务（替代「仅解压不注册」的旧行为）
// ----------------------------------------------------------------------------
// Redis 官方推荐以服务方式常驻运行（否则每次要手动 redis-server 前台启动）。
// 本步骤解压后把 redis-server 注册为系统服务并启动，使 Redis 开机自启、后台运行：
//   · Windows : redis-server --service-install + --service-start（需管理员）
//   · macOS   : brew services start redis
//   · Linux   : systemctl start redis（可能需 sudo）
// 所有系统命令经 ctx.run 执行：dryRun(applyEnv=false) 下为 no-op，绝不触碰系统。
// 注册/启动失败（如缺少管理员权限）仅记 warning，不回滚（Redis 本体已可用）。
// ============================================================================

export const redisServiceStep: InstallStep = {
  id: 'redis:service',
  title: '注册并启动服务',
  description: 'Windows: redis-server --service-install + --service-start；macOS: brew services start；Linux: systemctl start（失败仅警告）',
  optional: true,
  computeParams: (ctx) =>
    ctx.platform === 'win32'
      ? [{ key: 'serviceName', label: 'Windows 服务名', type: 'text', value: 'Redis' }]
      : [],
  preview: (ctx, v) => {
    if (ctx.platform === 'win32') {
      return {
        commands: [
          `redis-server --service-install redis.windows.conf --service-name ${v.serviceName} --loglevel verbose`,
          `redis-server --service-start --service-name ${v.serviceName}`,
        ],
        notes: ['注册并启动 Redis 服务（可选，需管理员，仅 Windows）'],
      };
    }
    if (ctx.platform === 'darwin') {
      return { commands: ['brew services start redis'], notes: ['通过 brew 启动 Redis 服务（可选，macOS）'] };
    }
    return { commands: ['systemctl start redis'], notes: ['通过 systemd 启动 Redis 服务（可选，Linux，可能需 sudo）'] };
  },
  run: async (ctx) => {
    const { binPath, platform, applyEnv, run, logger } = ctx;
    const serviceName = (ctx.params?.serviceName as string) || 'Redis';
    if (!applyEnv) {
      return { ok: true, message: '[dryRun] 跳过 Redis 服务注册（非应用环境变量模式）' };
    }
    if (platform !== 'win32') {
      // macOS / Linux：best-effort 启动系统服务（失败仅警告，不回滚）
      const cmd = platform === 'darwin' ? 'brew' : 'systemctl';
      const args = platform === 'darwin' ? ['services', 'start', 'redis'] : ['start', 'redis'];
      const svcRes = await run(cmd, args);
      if (svcRes.code === 0) return { ok: true, message: `Redis 服务已启动（${platform}）` };
      return {
        ok: false,
        warning: true,
        message: `Redis 服务启动跳过（${svcRes.stderr || '可能需 sudo / 手动 redis-server'}）`,
      };
    }
    const redisServer = path.join(binPath, 'redis-server.exe');
    // redis.windows.conf 位于解压根目录（与 redis-server.exe 同目录），传绝对路径更稳
    const conf = path.join(binPath, 'redis.windows.conf');
    const installRes = await run(redisServer, ['--service-install', conf, '--service-name', serviceName, '--loglevel', 'verbose']);
    if (installRes.code !== 0) {
      return {
        ok: false,
        warning: true,
        message: `Redis 服务注册跳过（${installRes.stderr || '可能缺少管理员权限'}）；可手动执行 redis-server --service-install ${conf} --service-name ${serviceName}`,
      };
    }
    logger.info(`[redis:service] 已注册 Redis Windows 服务 ${serviceName}`);
    const startRes = await run(redisServer, ['--service-start', '--service-name', serviceName]);
    if (startRes.code === 0) return { ok: true, message: 'Redis 服务已注册并启动（开机自启）' };
    return { ok: false, warning: true, message: `Redis 服务启动跳过（${startRes.stderr || '可手动 redis-server --service-start'}）` };
  },
};
