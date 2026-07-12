import React from 'react';
import { useStore } from '../store/useStore';
import { GlassCard } from '../components/GlassCard';
import { MagneticButton } from '../components/MagneticButton';

export function Profiles() {
  const profiles = useStore((s) => s.profiles);
  const applyProfile = useStore((s) => s.applyProfile);

  const list = Object.entries(profiles);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>配置<span className="gradient-text">方案</span></h1>
          <div className="desc">按项目切换一套版本组合（如“公司项目”用 JDK8 + Maven，“个人项目”用 JDK17 + Gradle）</div>
        </div>
      </div>

      <div className="wip-banner">
        <div className="wip-ico">🚧</div>
        <div className="wip-body">
          <div className="wip-title">功能待开发</div>
          <p className="wip-text">
            配置方案用于把<strong>「工具 → 版本」的映射</strong>存成一套命名的组合（例如「公司项目」= JDK 8 + Maven，「个人项目」= JDK 17 + Gradle）。
            点一次<strong>「一键应用」</strong>，就会把每个工具依次切到方案指定的版本，省去你逐个手动切换的麻烦。
          </p>
          <p className="wip-text">
            <strong>当前状态：</strong>底层的「一键应用」逻辑已就绪，但<strong>「新建 / 编辑 / 删除方案」入口尚未接通</strong>。
            真实配置里默认没有任何方案，因此桌面端打开本页为空；你在预览里看到的两张演示卡是 mock 数据，并非真实配置。
          </p>
          <p className="wip-text wip-plan">
            <strong>后续计划：</strong>补上方案的创建 / 编辑界面，并预置 1~2 套常用组合（如公司 JDK8+Maven、个人 JDK17+Gradle），让本页真正可用。
          </p>
        </div>
      </div>

      {list.length === 0 && (
        <GlassCard>
          <div className="muted small">暂无方案。本功能尚在开发中，后续将支持在应用内直接创建方案。</div>
        </GlassCard>
      )}

      <div className="grid cols-2">
        {list.map(([id, p]) => (
          <GlassCard key={id} title={p.label}>
            <div className="muted small">方案 ID：<span className="mono">{id}</span></div>
            <div className="mt">
              {Object.entries(p.tools).map(([tool, ver]) => (
                <span key={tool} className="badge active" style={{ marginRight: 8 }}>
                  {tool} → {ver}
                </span>
              ))}
            </div>
            <div className="mt">
              <MagneticButton className="btn primary" onClick={() => applyProfile(id)}>
                一键应用
              </MagneticButton>
            </div>
          </GlassCard>
        ))}
      </div>
    </>
  );
}
