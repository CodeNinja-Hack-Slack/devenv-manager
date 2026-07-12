import fsp from 'node:fs/promises';
import path from 'node:path';
import type { InstallStep } from '../../types.js';

// ============================================================================
// MySQL 安装步骤（替代原 postInstall 黑盒钩子，拆分为可见步骤）
// ----------------------------------------------------------------------------
// MySQL 官方 noinstall 包解压后仍不可用，必须依次完成：
//   1) mysql:myini  —— 生成 my.ini（basedir / datadir，仅 Windows）
//   2) mysql:init   —— 初始化数据目录（optional）
//        · Windows : mysqld --defaults-file=my.ini --initialize-insecure --console
//        · Linux   : mysqld --initialize-insecure --user=$USER --basedir --datadir
//        · macOS   : 同上（mysqld 位于 bin/，无 .exe）
//   3) mysql:service —— 注册并启动服务（optional，best-effort）
//        · Windows : mysqld --install + net start（需管理员）
//        · macOS   : brew services start mysql
//        · Linux   : systemctl start mysqld（可能需 sudo）
// 所有系统命令经 ctx.run 执行：dryRun(applyEnv=false) 下为 no-op，绝不触碰系统。
// 各步骤失败仅 warning 不回滚（MySQL 本体已可用），符合「环境变量最好别随便动」。
// ============================================================================

/** 1) 写 my.ini（basedir / datadir） */
export const mysqlMyIniStep: InstallStep = {
  id: 'mysql:myini',
  title: '生成 MySQL 配置文件',
  description: '写入 my.ini（basedir / datadir）',
  computeParams: (ctx) => [
    {
      key: 'dataDir',
      label: 'MySQL 数据目录',
      type: 'path',
      value: path.join(ctx.destDir, 'data'),
      hint: 'my.ini 中的 datadir，初始化数据存放处',
    },
  ],
  preview: (ctx, v) => {
    const dataDir = (v.dataDir as string) || path.join(ctx.destDir, 'data');
    return {
      files: [{ path: path.join(ctx.destDir, 'my.ini'), note: `basedir=${ctx.destDir}, datadir=${dataDir}` }],
      notes: ['仅 Windows 生成（其它平台按对应文档手动初始化）'],
    };
  },
  run: async (ctx) => {
    const { destDir, platform, logger } = ctx;
    if (platform !== 'win32') {
      return { ok: true, message: '非 Windows 平台，跳过 my.ini（请按对应平台文档手动初始化）' };
    }
    const dataDir = (ctx.params?.dataDir as string) || path.join(destDir, 'data');
    const myIni = path.join(destDir, 'my.ini');
    // Windows 下 my.ini 用反斜杠更稳妥（与 mysqld 解析一致）
    const iniBasedir = destDir.replace(/\//g, '\\');
    const iniDatadir = dataDir.replace(/\//g, '\\');
    const ini = ['[mysqld]', `basedir="${iniBasedir}"`, `datadir="${iniDatadir}"`, ''].join('\n');
    await fsp.writeFile(myIni, ini, 'utf8');
    logger.info(`[mysql:myini] 已生成 my.ini basedir=${iniBasedir}`);
    return { ok: true, message: `已生成 my.ini（basedir=${iniBasedir}, datadir=${iniDatadir}）` };
  },
};

/** 2) 初始化数据目录（optional：失败仅警告、不回滚） */
export const mysqlInitStep: InstallStep = {
  id: 'mysql:init',
  title: '初始化数据目录',
  description: 'mysqld --initialize-insecure（root 无密码，便于开发）',
  optional: true,
  preview: (ctx) => {
    const dataDir = (ctx.params?.dataDir as string) || path.join(ctx.destDir, 'data');
    if (ctx.platform === 'win32') {
      return {
        commands: ['mysqld --defaults-file=my.ini --initialize-insecure --console'],
        notes: ['初始化数据目录（可选，Windows）'],
      };
    }
    return {
      commands: [
        `mysqld --initialize-insecure --user=$USER --basedir=${ctx.destDir} --datadir=${dataDir}`,
      ],
      notes: ['初始化数据目录（可选，Linux/macOS；root 无密码，便于开发）'],
    };
  },
  run: async (ctx) => {
    const { destDir, platform, run, logger } = ctx;
    const dataDir = (ctx.params?.dataDir as string) || path.join(destDir, 'data');
    const mysqld = platform === 'win32'
      ? path.join(destDir, 'bin', 'mysqld.exe')
      : path.join(destDir, 'bin', 'mysqld');
    if (platform === 'win32') {
      const myIni = path.join(destDir, 'my.ini');
      const df = `--defaults-file=${myIni}`;
      const initRes = await run(mysqld, [df, '--initialize-insecure', '--console']);
      if (initRes.code !== 0) {
        return {
          ok: false,
          warning: true,
          message: `数据目录初始化失败（退出码 ${initRes.code}）：${initRes.stderr || initRes.stdout || '无输出'}`,
        };
      }
      logger.info('[mysql:init] 数据目录初始化完成');
      return { ok: true, message: '数据目录初始化完成（--initialize-insecure，root 无密码）' };
    }
    // Linux / macOS：需显式 --user / --basedir / --datadir
    const user = process.env.USER || process.env.USERNAME || 'mysql';
    const initRes = await run(mysqld, [
      '--initialize-insecure',
      `--user=${user}`,
      `--basedir=${destDir}`,
      `--datadir=${dataDir}`,
    ]);
    if (initRes.code !== 0) {
      return {
        ok: false,
        warning: true,
        message: `数据目录初始化失败（退出码 ${initRes.code}）：${initRes.stderr || initRes.stdout || '无输出'}`,
      };
    }
    logger.info('[mysql:init] 数据目录初始化完成');
    return { ok: true, message: `数据目录初始化完成（--initialize-insecure，root 无密码；dataDir=${dataDir}）` };
  },
};

/** 3) 注册并启动 Windows 服务（optional：需管理员，失败仅警告） */
export const mysqlServiceStep: InstallStep = {
  id: 'mysql:service',
  title: '注册并启动 Windows 服务',
  description: 'mysqld --install 注册服务并 net start（需管理员；失败仅警告）',
  optional: true,
  computeParams: (ctx) =>
    ctx.platform === 'win32'
      ? [{ key: 'serviceName', label: 'Windows 服务名', type: 'text', value: 'MySQL' }]
      : [],
  preview: (ctx, v) => {
    if (ctx.platform === 'win32') {
      return {
        commands: [`mysqld --defaults-file=my.ini --install ${v.serviceName}`, `net start ${v.serviceName}`],
        notes: ['注册并启动 Windows 服务（可选，需管理员）'],
      };
    }
    if (ctx.platform === 'darwin') {
      return { commands: ['brew services start mysql'], notes: ['通过 brew 启动 MySQL 服务（可选，macOS）'] };
    }
    return { commands: ['systemctl start mysqld'], notes: ['通过 systemd 启动 MySQL 服务（可选，Linux，可能需 sudo）'] };
  },
  run: async (ctx) => {
    const { destDir, platform, applyEnv, run, logger } = ctx;
    const serviceName = (ctx.params?.serviceName as string) || 'MySQL';
    if (!applyEnv) {
      return { ok: true, message: '[dryRun] 跳过 MySQL 服务注册（非应用环境变量模式）' };
    }
    if (platform !== 'win32') {
      // macOS / Linux：best-effort 启动系统服务（失败仅警告）
      const cmd = platform === 'darwin' ? 'brew' : 'systemctl';
      const args = platform === 'darwin' ? ['services', 'start', 'mysql'] : ['start', 'mysqld'];
      const svcRes = await run(cmd, args);
      if (svcRes.code === 0) return { ok: true, message: `MySQL 服务已启动（${platform}）` };
      return {
        ok: false,
        warning: true,
        message: `MySQL 服务启动跳过（${svcRes.stderr || '需管理员/sudo 或手动启动'}）`,
      };
    }
    const mysqld = path.join(destDir, 'bin', 'mysqld.exe');
    const myIni = path.join(destDir, 'my.ini');
    const df = `--defaults-file=${myIni}`;
    const svcRes = await run(mysqld, [df, '--install', serviceName]);
    if (svcRes.code !== 0) {
      return {
        ok: false,
        warning: true,
        message: `Windows 服务注册跳过（${svcRes.stderr || '可能缺少管理员权限'}）；可手动执行 mysqld --install ${serviceName}`,
      };
    }
    logger.info(`[mysql:service] 已注册 Windows 服务 ${serviceName}`);
    const startRes = await run('net', ['start', serviceName]);
    if (startRes.code === 0) return { ok: true, message: `${serviceName} 服务已启动` };
    return { ok: false, warning: true, message: `${serviceName} 服务启动跳过（${startRes.stderr || '可手动 net start ' + serviceName}）` };
  },
};
