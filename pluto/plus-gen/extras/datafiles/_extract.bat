call "%~dp0..\..\deps.bat"
"..\Warframe-Exporter-CLI_Windows.exe" --game Warframe --cache-dir "%WARFRAME_CACHE_DIR%" --package Misc --write-raw --internal-path Lotus/Syndicates
"..\Warframe-Exporter-CLI_Windows.exe" --game Warframe --cache-dir "%WARFRAME_CACHE_DIR%" --package Misc --write-raw --internal-path Lotus/Types/Game/Store/DojoRecipeManifest
"..\Warframe-Exporter-CLI_Windows.exe" --game Warframe --cache-dir "%WARFRAME_CACHE_DIR%" --package Misc --write-raw --internal-path Lotus/Types/Game/VendorManifests
pluto jsonify.pluto
