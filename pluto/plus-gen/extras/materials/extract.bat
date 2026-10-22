call "%~dp0..\..\deps.bat"
"..\Warframe-Exporter-CLI_Windows.exe" --game Warframe --cache-dir "%WARFRAME_CACHE_DIR%" --extract-materials --internal-path EE
"..\Warframe-Exporter-CLI_Windows.exe" --game Warframe --cache-dir "%WARFRAME_CACHE_DIR%" --extract-materials --internal-path Lotus