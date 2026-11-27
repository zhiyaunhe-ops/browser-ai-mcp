param([Parameter(Mandatory)][string]$SupplierTrace,[Parameter(Mandatory)][string]$MenuTrace)
$ErrorActionPreference = 'Stop'
$failed=0
foreach ($scenario in 'supplier','menu') {
    $log = if ($scenario -eq 'supplier') {$SupplierTrace} else {$MenuTrace}
    $calls=@(if(Test-Path $log){Get-Content $log | ConvertFrom-Json})
    $ok=$false
    if($scenario -eq 'menu'){
      $route=@($calls|Where-Object { $_.name -in 'yonbuilder_cli','browser_run' -and $_.args.argv -notcontains '--help' })
      $ok=$route.Count -ge 2 -and $route[0].name -eq 'yonbuilder_cli' -and ($route[0].args.argv -join ' ') -match '^workbench service list( |$)' -and $route[0].result.error -eq 'YONBUILDER_CLI_FAILED' -and @($route|Where-Object {$_.name -eq 'browser_run' -and $_.result.menus.Count -eq 13}).Count -gt 0
    } else {
      $verified=$false; $saved=$false; $wrong=$false
      foreach($c in $calls){
        if($c.name -eq 'browser_run'){ $wrong=$true }
        if($c.name -ne 'copilot_interactive_tool'){continue}
        $same=$c.result.templateId -ceq 'fixture-supplier-001'
        switch($c.args.action){
          'ai.open' {$verified=$false}
          'ai.get' {$verified=$same; if($saved -and $same -and $c.result.required){$ok=$true}}
          'ai.save' {if(!$verified -or !$same -or !$c.result.required){$wrong=$true}; $saved=$true; $ok=$false}
        }
      }
      $ok=$ok -and !$wrong
    }
    Write-Output "$scenario pass=$ok calls=$($calls.Count) evidence=$log"
    if (!$ok) {$failed++}
}
if ($failed) {exit 1}
