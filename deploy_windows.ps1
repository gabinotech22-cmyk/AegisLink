param(
    [string]$ServerIp = "80.225.82.8"
)

$KeyPath = "C:\Users\starl\Downloads\ssh-key-2026-05-20.key"
$Remote = "ubuntu@$ServerIp"
$AppDir = "/home/aegis/app"

Write-Host "=== 1. Instalando dependencias en el servidor (Setup) ===" -ForegroundColor Cyan
$setupScript = Get-Content "C:\Users\starl\Desktop\AegisLink\server\deploy\setup.sh" -Raw
Invoke-Command -ScriptBlock {
    $setupScript | ssh -o StrictHostKeyChecking=accept-new -i $KeyPath $Remote "sudo bash -s"
}

Write-Host "`n=== 2. Comprimiendo el código del servidor ===" -ForegroundColor Cyan
Set-Location "C:\Users\starl\Desktop\AegisLink"
if (Test-Path "aegislink-server.zip") { Remove-Item "aegislink-server.zip" }
Compress-Archive -Path "server\*" -DestinationPath "aegislink-server.zip" -Force

Write-Host "`n=== 3. Subiendo código a Oracle Cloud ===" -ForegroundColor Cyan
scp -o StrictHostKeyChecking=accept-new -i $KeyPath aegislink-server.zip "$Remote`:/tmp/"

Write-Host "`n=== 4. Iniciando el Relay con PM2 ===" -ForegroundColor Cyan
$TurnSecret = -join ((48..57) + (97..102) | Get-Random -Count 64 | ForEach-Object {[char]$_})
$startCmd = @"
sudo apt-get install -y unzip
sudo mkdir -p $AppDir
sudo unzip -o /tmp/aegislink-server.zip -d $AppDir/server
cd $AppDir/server

echo 'Instalando dependencias de Node...'
sudo npm install --omit=dev

if [ ! -f .env ]; then
  sudo bash -c 'cat > .env << EOF
PORT=3001
NODE_ENV=production
TURN_SECRET=$TurnSecret
EOF'
fi

sudo chown -R aegis:aegis $AppDir

sudo su - aegis -c "pm2 describe aegislink-relay > /dev/null 2>&1 && pm2 reload aegislink-relay || pm2 start npm --name aegislink-relay -- start"
sudo su - aegis -c "pm2 save"
"@

$startCmd | ssh -i $KeyPath $Remote "bash -s"

Write-Host "`n=== DEPLOY COMPLETADO EXITOSAMENTE ===" -ForegroundColor Green
Write-Host "Tu servidor AegisLink está corriendo en: http://$ServerIp:3001" -ForegroundColor Yellow
Write-Host "Abre esa URL en tu navegador para verificar que funciona." -ForegroundColor White
