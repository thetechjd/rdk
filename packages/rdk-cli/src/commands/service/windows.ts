// packages/rdk-cli/src/commands/service/windows.ts

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const TASK_NAME     = 'RetroDeck-RDK';
const TASK_XML_PATH = path.join(os.tmpdir(), 'rdk-task.xml');

function buildTaskXml(rdkPath: string, _logDir: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>RDK — Retrieval Development Kit node</Description>
    <Author>RetroDeck</Author>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${os.userInfo().username}</UserId>
      <Delay>PT30S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${os.userInfo().username}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${rdkPath}</Command>
      <Arguments>mcp:serve</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

async function findRdkBinary(): Promise<string> {
  try {
    const { stdout } = await execAsync('where rdk');
    return stdout.split('\n')[0].trim();
  } catch {
    throw new Error('Cannot find rdk binary. Is RDK installed and in your PATH?');
  }
}

export const WindowsAdapter = {
  async install() {
    const rdkPath = await findRdkBinary();
    const logDir  = path.join(os.homedir(), '.rdk', 'logs');
    await fs.mkdir(logDir, { recursive: true });

    const taskXml = buildTaskXml(rdkPath, logDir);
    // Windows requires UTF-16 LE with BOM for schtasks XML import
    await fs.writeFile(TASK_XML_PATH, '﻿' + taskXml, 'utf16le');

    try {
      execSync(`schtasks /Delete /TN ${TASK_NAME} /F`, { stdio: 'ignore' });
    } catch {}

    execSync(`schtasks /Create /XML "${TASK_XML_PATH}" /TN ${TASK_NAME}`, { stdio: 'inherit' });
    execSync(`schtasks /Run /TN ${TASK_NAME}`, { stdio: 'inherit' });
  },

  async uninstall() {
    try { execSync(`schtasks /End /TN ${TASK_NAME}`,    { stdio: 'ignore' }); } catch {}
    try { execSync(`schtasks /Delete /TN ${TASK_NAME} /F`, { stdio: 'ignore' }); } catch {}
  },

  async start() {
    execSync(`schtasks /Run /TN ${TASK_NAME}`, { stdio: 'inherit' });
  },

  async stop() {
    execSync(`schtasks /End /TN ${TASK_NAME}`, { stdio: 'inherit' });
  },

  async status() {
    try {
      const { stdout } = await execAsync(`schtasks /Query /TN ${TASK_NAME} /FO LIST /V`);
      const statusMatch = stdout.match(/Status:\s+(\w+)/);
      const running     = statusMatch?.[1]?.toLowerCase() === 'running';
      return { installed: true, running };
    } catch {
      return { installed: false, running: false };
    }
  },
};
