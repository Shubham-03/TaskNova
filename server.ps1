$root = "C:\Users\shubh\OneDrive\Desktop\Antigravity\Task Management"
$port = 7799
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:${port}/")
$listener.Start()
Write-Host "Server running at http://localhost:${port}/"

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $urlPath = $ctx.Request.Url.AbsolutePath
    if ($urlPath -eq "/") { $urlPath = "/index.html" }
    $localPath = $urlPath.TrimStart("/").Replace("/", "\")
    $filePath = Join-Path $root $localPath

    $res = $ctx.Response
    if (Test-Path $filePath -PathType Leaf) {
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
        $ct = switch ($ext) {
            ".html" { "text/html; charset=utf-8" }
            ".css"  { "text/css; charset=utf-8" }
            ".js"   { "application/javascript; charset=utf-8" }
            default { "application/octet-stream" }
        }
        $res.ContentType = $ct
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $res.StatusCode = 404
        $msg = [System.Text.Encoding]::UTF8.GetBytes("Not found")
        $res.ContentLength64 = $msg.Length
        $res.OutputStream.Write($msg, 0, $msg.Length)
    }
    $res.Close()
}
