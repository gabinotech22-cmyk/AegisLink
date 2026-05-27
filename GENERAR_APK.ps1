Write-Host "=== AEGISLINK: INICIANDO GENERACIÓN DE APK NATIVO ===" -ForegroundColor Cyan

# 1. Entrar en la carpeta mobile
$MobilePath = "$PSScriptRoot\mobile"
Set-Location $MobilePath

# 2. Verificar dependencias
if (!(Test-Path "node_modules")) {
    Write-Host "`n[1/3] Instalando dependencias de Node..." -ForegroundColor Yellow
    npm install
}

# 3. Prebuild de Expo (Genera la carpeta /android nativa)
Write-Host "`n[2/3] Generando estructura nativa de Android..." -ForegroundColor Yellow
npx expo prebuild --platform android --no-install

# 4. Compilar APK con Gradle
Write-Host "`n[3/3] Compilando APK final (Release)..." -ForegroundColor Yellow
cd android
./gradlew assembleRelease

if ($LASTEXITCODE -eq 0) {
    $apk = Get-ChildItem -Path "app\build\outputs\apk\release\*.apk" | Select-Object -First 1
    Write-Host "`n==============================================" -ForegroundColor Green
    Write-Host "¡APK GENERADO CON ÉXITO!" -ForegroundColor Green
    Write-Host "Ubicación: $($apk.FullName)" -ForegroundColor White
    Write-Host "==============================================" -ForegroundColor Green
} else {
    Write-Host "`n[!] ERROR: Hubo un fallo en la compilación." -ForegroundColor Red
    Write-Host "Asegúrate de tener instalado Java JDK 17 y el Android SDK." -ForegroundColor White
}

Write-Host "`nPresiona cualquier tecla para cerrar esta ventana..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
