$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$connection = [System.Data.SqlClient.SqlConnection]::new($env:BROWSER_AI_SCHEMA_CONNECTION)
try {
    $connection.Open()
    $command = $connection.CreateCommand()
    $command.CommandTimeout = 30
    $command.CommandText = $env:BROWSER_AI_SCHEMA_QUERY
    [Console]::Write($command.ExecuteScalar())
} finally {
    $connection.Dispose()
}
