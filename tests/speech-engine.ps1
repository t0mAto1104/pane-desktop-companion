$ErrorActionPreference='Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$recognizer=[System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Select-Object -First 1
if (!$recognizer) { throw 'No installed System.Speech recognizer' }
$speaker=[System.Speech.Synthesis.SpeechSynthesizer]::new()
$stream=[IO.MemoryStream]::new()
$engine=$null
try {
    $start=[Diagnostics.Stopwatch]::StartNew()
    $voice=$speaker.GetInstalledVoices() | Where-Object {
        $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $recognizer.Culture.TwoLetterISOLanguageName
    } | Select-Object -First 1
    if (!$voice) { throw 'Recognizer has no matching local voice' }
    $speaker.SelectVoice($voice.VoiceInfo.Name)
    $speaker.SetOutputToWaveStream($stream)
    $sample=if ($recognizer.Culture.TwoLetterISOLanguageName -eq 'zh') { (-join (0x8fd9,0x662f,0x8bed,0x97f3,0x6d4b,0x8bd5 | ForEach-Object { [char]$_ })) } else { 'This is a speech test' }
    $speaker.Speak($sample)
    $speaker.SetOutputToNull()
    $stream.Position=0
    $engine=[System.Speech.Recognition.SpeechRecognitionEngine]::new($recognizer)
    $engine.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
    $engine.SetInputToWaveStream($stream)
    $result=$engine.Recognize([TimeSpan]::FromSeconds(8))
    if (!$result -or !$result.Text) { throw 'Synthetic WAV did not produce recognized text' }
    [pscustomobject]@{ Culture=$recognizer.Culture.Name; AudioBytes=$stream.Length; Recognized=$true; ElapsedMs=$start.ElapsedMilliseconds } | ConvertTo-Json -Compress
} finally {
    if ($engine) { $engine.Dispose() }
    $speaker.Dispose()
    $stream.Dispose()
}
