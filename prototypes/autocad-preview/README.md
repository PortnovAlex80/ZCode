# AutoCAD 2024: палитра ZCODE

Native net48/x64 plug-in с PaletteSet, WebView2 и общей панелью документа. Установка, подключение и проверки: [общая инструкция](../document-host/README.md). Контракты: [SRS](../../docs/spec-harness/DOCUMENT-HOSTS.md).

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File prototypes\autocad-preview\Build-AutoCAD-Preview.ps1
```

DLL и все зависимости: `%LOCALAPPDATA%\SpecHarness\autocad-preview\plugin`. В AutoCAD: `NETLOAD` → `SpecHarness.AutoCAD.dll` → `SHDOC`. Можно закрепить палитру или переместить её; для закрытого AutoCAD есть `Start-AutoCAD-Preview.ps1`. Ни Build, ни чтение выделения не запускают ZCODE. HTTPS/WSS соединение с общим Host включается отдельно.

Чтение возвращает данные самого открытого Drawing, включая несохранённое состояние. Поддержаны LINE/CIRCLE/ARC/LWPOLYLINE/TEXT/MTEXT, явные units и WCS/OCS. Переход использует текущий layout и handles. Применение — ограниченная смена слоя в DocumentLock/transaction; duplicate/stale/locked/xref отказываются. Смена активного Drawing и reload палитры инвалидируют ещё не начатые запросы, старый Drawing не активируется автоматически.

Компиляция и native API acceptance выполнены. GUI WebView/перемещение палитры и live модельная цепочка пока не проверялись; графический AutoCAD не запускался во время активных ZCODE сессий. WebView2 NuGet версия закреплена в `packages.lock.json`; SDK сборки берётся из установленного AutoCAD 2024, его файлы не модифицируются.
