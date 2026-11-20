# Local test only: serves this code to the rider app's dev build on the Android
# emulator, talking to the local website/API through http://localhost:19869
# (adb reverse). localhost keeps the camera page a secure context, which Go Live needs.
# .env.local (an emulator address for the API) is set aside while this runs; put it
# back afterwards: Rename-Item .env.local.testing-bak .env.local
Set-Location 'C:\Users\trenton.nelson\Desktop\RM TrackR\RM-Tracker\artifacts\rider-app'
if (Test-Path .env.local) { Rename-Item .env.local .env.local.testing-bak }
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:Path = "$env:ANDROID_HOME\platform-tools;$env:Path"
$env:EXPO_PUBLIC_API_URL = 'http://localhost:19869'
$env:EXPO_PUBLIC_DOMAIN = 'localhost:19869'
adb reverse tcp:19869 tcp:19869
adb reverse tcp:8100 tcp:8100
npx expo start --dev-client --port 8100 --clear
