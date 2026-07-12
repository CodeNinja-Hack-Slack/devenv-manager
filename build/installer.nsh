; ============================================================================
; DevEnv Manager — 自定义 NSIS 脚本（electron-builder include）
;
; 痛点：重装/升级时，electron-builder 的卸载器会先把整个 $INSTDIR 移走
;       （un.atomicRMDir）或 RMDir /r 清空，导致用户放在安装目录内的
;       数据文件夹（如手动创建的 installData）一并丢失。
;
; 方案：
;   customUnInstall  —— 在「旧卸载器」中执行（升级时先跑旧卸载器）：
;                       把用户数据文件夹移出 $INSTDIR 到持久临时目录 $TEMP。
;   customInstall   —— 在「新安装器」中执行（程序文件写入之后）：
;                       把暂存的用户数据移回 $INSTDIR。
;
; 说明：当前已安装的旧版卸载器不含本逻辑，故「本次」升级仍可能清掉旧目录；
;       本脚本保护的是「未来」的升级（新构建的卸载器生效）。
;       软件自身的运行时配置已改为写入 userData（安装目录之外），天然不受此影响。
; ============================================================================

!macro customUnInstall
  ; 把用户数据文件夹移出安装目录，避免被 atomicRMDir / RMDir 清掉
  CreateDirectory "$TEMP\DevEnvManager-userdata"
  ${if} ${FileExists} "$INSTDIR\installData"
    Rename "$INSTDIR\installData" "$TEMP\DevEnvManager-userdata\installData"
  ${endIf}
  ${if} ${FileExists} "$INSTDIR\devenv-data"
    Rename "$INSTDIR\devenv-data" "$TEMP\DevEnvManager-userdata\devenv-data"
  ${endIf}
!macroend

!macro customInstall
  ; 把升级前暂存的用户数据移回安装目录（仅当存在、且目标不存在时）
  ${if} ${FileExists} "$TEMP\DevEnvManager-userdata\installData"
    ${ifNot} ${FileExists} "$INSTDIR\installData"
      Rename "$TEMP\DevEnvManager-userdata\installData" "$INSTDIR\installData"
    ${endIf}
  ${endIf}
  ${if} ${FileExists} "$TEMP\DevEnvManager-userdata\devenv-data"
    ${ifNot} ${FileExists} "$INSTDIR\devenv-data"
      Rename "$TEMP\DevEnvManager-userdata\devenv-data" "$INSTDIR\devenv-data"
    ${endIf}
  ${endIf}
!macroend
