; 络雀 NSIS 安装钩子：把「络雀」放进资源管理器的「发送到」菜单。
;
; 「发送到」会把选中的文件/文件夹路径追加到快捷方式目标后面，
; 应用启动参数里只认「存在的路径」，因此直接 `ploceus.exe <文件…>` 就能导入；
; 已在运行时由单实例转发给前台窗口（见 lib.rs 的 single_instance 回调）。
;
; 卸载时一并删除，不留下失效项。

!macro NSIS_HOOK_POSTINSTALL
  CreateShortcut "$APPDATA\Microsoft\Windows\SendTo\络雀.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$APPDATA\Microsoft\Windows\SendTo\络雀.lnk"
!macroend
