import React from "react";
import { Link } from "react-router-dom";
import { Flex, Container, Grid } from "@dynatrace/strato-components/layouts";
import { Heading, Text } from "@dynatrace/strato-components/typography";
import { Colors } from "@dynatrace/strato-design-tokens";
import { useDql } from "@dynatrace-sdk/react-hooks";
import { ProgressCircle } from "@dynatrace/strato-components/content";
import { TimeseriesChart } from "@dynatrace/strato-components-preview/charts";
import { SingleValue } from "@dynatrace/strato-components-preview/charts";
import type { Timeseries } from "@dynatrace/strato-components/charts";

function parseIntervalMs(interval: string): number {
  const m = interval.match(/PT?(\d+)([MHDS])/i);
  if (!m) return 60000;
  const n = parseInt(m[1], 10);
  switch (m[2].toUpperCase()) {
    case "S": return n * 1000;
    case "M": return n * 60_000;
    case "H": return n * 3_600_000;
    case "D": return n * 86_400_000;
    default:  return 60_000;
  }
}

function dqlToTimeseries(
  name: string,
  values: (number | null)[],
  timeframeStart: string,
  interval: string
): Timeseries {
  const start = new Date(timeframeStart).getTime();
  const step = parseIntervalMs(interval);
  const datapoints = values
    .map((v, i) => ({ start: new Date(start + i * step), value: v as number }))
    .filter((d) => d.value !== null && d.value !== undefined);
  return { name, datapoints };
}

const KUBEVIRT_HOST = "HOST-ED614B79A95C56F2";

export const Home = () => {
  const hostMetricsResult = useDql({
    query: `timeseries cpu=avg(dt.host.cpu.usage), mem=avg(dt.host.memory.usage), by:{dt.entity.host}
| filter dt.entity.host == "${KUBEVIRT_HOST}"`,
  });

  const activeVMsResult = useDql({
    query: `smartscapeNodes K8S_POD
| filter matchesPhrase(k8s.pod.name, "virt-launcher")
| filter isNull(k8s.pod.deletion_timestamp)
| fields k8s.pod.name, k8s.node.name`,
  });

  const totalVMsResult = useDql({
    query: `smartscapeNodes K8S_POD
| filter matchesPhrase(k8s.pod.name, "virt-launcher")
| filter isNull(k8s.pod.deletion_timestamp)
| filter in(k8s.pod.phase, "Running", "Pending", "Unknown")
| summarize count()`,
  });

  const runningVMsResult = useDql({
    query: `smartscapeNodes K8S_POD
| filter matchesPhrase(k8s.pod.name, "virt-launcher")
| filter isNull(k8s.pod.deletion_timestamp)
| filter k8s.pod.phase == "Running"
| summarize count()`,
  });

  const nodesResult = useDql({
    query: `smartscapeNodes K8S_NODE
| fieldsAdd schedulable = \`tags:k8s.labels\`[\`kubevirt.io/schedulable\`]
| filter schedulable == "true"
| summarize total=count()`,
  });

  const oneAgentNodesResult = useDql({
    query: `fetch dt.entity.kubernetes_node
| fieldsAdd belongs_to
| fields entity.name, belongs_to`,
  });

  const errorSummaryResult = useDql({
    query: `fetch logs, from:now()-1h
| filter matchesPhrase(k8s.pod.name, "virt-launcher")
| summarize errors=countIf(loglevel=="ERROR")`,
  });

  const guestVMsResult = useDql({
    query: `smartscapeNodes HOST
| filter hypervisor.type == "HYPERVISOR_TYPE_KVM"
| fields name, id`,
  });

  const infraProblemsResult = useDql({
    query: `fetch dt.davis.problems
| filter not(dt.davis.is_duplicate) and event.status == "ACTIVE"
| filter in(toSmartscapeId("${KUBEVIRT_HOST}"), smartscape.affected_entity.ids)
    or matchesPhrase(root_cause_entity_id, "${KUBEVIRT_HOST}")
| summarize count()`,
  });

  const vmProblemsResult = useDql({
    query: `fetch dt.davis.problems
| filter not(dt.davis.is_duplicate) and event.status == "ACTIVE"
| filter matchesPhrase(arrayToString(smartscape.affected_entity.types, delimiter:","), "K8S_POD")
| summarize count()`,
  });

  const vmDeploymentsResult = useDql({
    query: `smartscapeNodes "K8S*"
| filter type == "K8S_POD"
| filter \`tags:k8s.labels\`[kubevirt.io] == "virt-launcher"
| filter getStart(lifetime) > now() - 24h
| summarize count()`,
  });

  const vmDeletionsResult = useDql({
    query: `smartscapeNodes "K8S*", from: -24h
| filter type == "K8S_POD"
| filter \`tags:k8s.labels\`[kubevirt.io] == "virt-launcher"
| filter isNotNull(k8s.pod.deletion_timestamp)
| summarize count()`,
  });

  const networkResult = useDql({
    query: `timeseries netin=avg(dt.host.net.nic.bytes_rx), netout=avg(dt.host.net.nic.bytes_tx), by:{dt.entity.host}
| filter dt.entity.host == "${KUBEVIRT_HOST}"`,
  });

  const pvcResult = useDql({
    query: [
      'smartscapeNodes "K8S*"',
      '| filter type == "K8S_PERSISTENTVOLUMECLAIM"',
      '| filter isNotNull(`tags:k8s.annotations`[`cdi.kubevirt.io/createdForDataVolume`])',
      '| fieldsAdd pvc_type = `tags:k8s.annotations`[`cdi.kubevirt.io/storage.contentType`]',
      '| filter pvc_type == "kubevirt"',
      '| fields name, k8s.namespace.name',
    ].join('\n'),
  });

  const isLoading =
    infraProblemsResult.isLoading ||
    vmProblemsResult.isLoading ||
    vmDeploymentsResult.isLoading ||
    vmDeletionsResult.isLoading ||
    guestVMsResult.isLoading ||
    networkResult.isLoading ||
    hostMetricsResult.isLoading ||
    activeVMsResult.isLoading ||
    totalVMsResult.isLoading ||
    runningVMsResult.isLoading ||
    nodesResult.isLoading ||
    oneAgentNodesResult.isLoading ||
    errorSummaryResult.isLoading;

  type HostRecord = {
    "dt.entity.host": string;
    timeframe: { start: string; end: string };
    interval: string;
    cpu: (number | null)[];
    mem: (number | null)[];
  };
  const hostRec = (hostMetricsResult.data?.records?.[0] ?? null) as HostRecord | null;
  const cpuSeries: Timeseries | null = hostRec
    ? dqlToTimeseries("CPU Usage", hostRec.cpu, hostRec.timeframe.start, hostRec.interval)
    : null;
  const memSeries: Timeseries | null = hostRec
    ? dqlToTimeseries("Memory Usage", hostRec.mem, hostRec.timeframe.start, hostRec.interval)
    : null;
  const latestCPU = hostRec?.cpu?.reduce<number | null>((acc, v) => (v !== null ? v : acc), null) ?? null;
  const latestMem = hostRec?.mem?.reduce<number | null>((acc, v) => (v !== null ? v : acc), null) ?? null;

  type VMRecord = { "k8s.pod.name": string; "k8s.node.name": string };
  const vmRecords = (activeVMsResult.data?.records ?? []) as VMRecord[];
  const totalVMs = parseInt((totalVMsResult.data?.records?.[0] as { "count()": string } | undefined)?.["count()"] ?? "0", 10);
  const runningVMs = parseInt((runningVMsResult.data?.records?.[0] as { "count()": string } | undefined)?.["count()"] ?? "0", 10);

  type NodeRecord = { total: string };
  const nodeRecords = (nodesResult.data?.records ?? []) as NodeRecord[];
  const totalVirtNodes = parseInt(nodeRecords[0]?.total ?? "0", 10);
  const virtNodeNames = new Set(vmRecords.map((r) => r["k8s.node.name"]));
  const virtEnabledNodes = virtNodeNames.size;
  type OneAgentNodeRecord = { "entity.name": string; belongs_to: { "dt.entity.host"?: string } | null };
  const oneAgentNodeRecords = (oneAgentNodesResult.data?.records ?? []) as OneAgentNodeRecord[];
  const nodesWithAgent = oneAgentNodeRecords.filter(
    (n) => virtNodeNames.has(n["entity.name"]) && !!n.belongs_to?.["dt.entity.host"]
  ).length;

  type ErrorSummary = { errors: string };
  const errSum = (errorSummaryResult.data?.records?.[0] ?? null) as ErrorSummary | null;
  const errorCount = parseInt(errSum?.errors ?? "0", 10);

  type NetworkRecord = {
    "dt.entity.host": string;
    timeframe: { start: string; end: string };
    interval: string;
    netin: (number | null)[];
    netout: (number | null)[];
  };
  const netRec = (networkResult.data?.records?.[0] ?? null) as NetworkRecord | null;
  const netInSeries: Timeseries | null = netRec
    ? dqlToTimeseries("Network In", netRec.netin, netRec.timeframe.start, netRec.interval)
    : null;
  const netOutSeries: Timeseries | null = netRec
    ? dqlToTimeseries("Network Out", netRec.netout, netRec.timeframe.start, netRec.interval)
    : null;
  const latestNetIn = netRec?.netin?.reduce<number | null>((acc, v) => (v !== null ? v : acc), null) ?? null;
  const latestNetOut = netRec?.netout?.reduce<number | null>((acc, v) => (v !== null ? v : acc), null) ?? null;
  const formatBytes = (b: number | null) => b === null ? null : b >= 1_000_000 ? `${(b / 1_000_000).toFixed(1)} MB/s` : b >= 1_000 ? `${(b / 1_000).toFixed(1)} KB/s` : `${b.toFixed(0)} B/s`;

  type GuestVMRecord = { name: string; id: string };
  const guestVMRecords = (guestVMsResult.data?.records ?? []) as GuestVMRecord[];

  type CountRecord = { "count()": string };
  const infraProblems = parseInt((infraProblemsResult.data?.records?.[0] as CountRecord | undefined)?.["count()"] ?? "0", 10);
  const vmProblems = parseInt((vmProblemsResult.data?.records?.[0] as CountRecord | undefined)?.["count()"] ?? "0", 10);
  const vmDeployments24h = parseInt((vmDeploymentsResult.data?.records?.[0] as CountRecord | undefined)?.["count()"] ?? "0", 10);
  const vmDeletions24h = parseInt((vmDeletionsResult.data?.records?.[0] as CountRecord | undefined)?.["count()"] ?? "0", 10);

  type PVCRecord = { name: string; "k8s.namespace.name": string };
  const pvcRecords = (pvcResult.data?.records ?? []) as PVCRecord[];

  if (isLoading) {
    return (
      <Flex alignItems="center" justifyContent="center" style={{ height: 300 }}>
        <ProgressCircle />
      </Flex>
    );
  }

  return (
    <Flex flexDirection="column" padding={32} gap={24}>
      <Flex justifyContent="space-between" alignItems="center">
        <Heading level={1} style={{ margin: 0 }}>KubeVirt Dashboard</Heading>
        <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>Live · updated now</Text>
      </Flex>

      {/* Activity & problems tiles */}
      <Grid gridTemplateColumns="repeat(4, 1fr)" gap={16}>
        <Container style={{ padding: 20, borderRadius: 8 }}>
          <SingleValue
            label="VM Deployments (24h)"
            data={vmDeploymentsResult.isLoading ? "…" : vmDeployments24h}
            height={100}
            color={vmDeployments24h > 0 ? Colors.Text.Primary.Default : Colors.Text.Neutral.Subdued}
          />
        </Container>
        <Container style={{ padding: 20, borderRadius: 8 }}>
          <SingleValue
            label="VM Deletions (24h)"
            data={vmDeletionsResult.isLoading ? "…" : vmDeletions24h}
            height={100}
            color={vmDeletions24h > 0 ? Colors.Text.Warning.Default : Colors.Text.Neutral.Subdued}
          />
        </Container>
        <Container style={{ padding: 20, borderRadius: 8 }}>
          <SingleValue
            label="Infra Problems (active)"
            data={infraProblemsResult.isLoading ? "…" : infraProblems}
            height={100}
            color={infraProblems > 0 ? Colors.Text.Critical.Default : Colors.Text.Success.Default}
          />
        </Container>
        <Container style={{ padding: 20, borderRadius: 8 }}>
          <SingleValue
            label="VM Problems (active)"
            data={vmProblemsResult.isLoading ? "…" : vmProblems}
            height={100}
            color={vmProblems > 0 ? Colors.Text.Critical.Default : Colors.Text.Success.Default}
          />
        </Container>
      </Grid>

      {/* Charts */}
      <Grid gridTemplateColumns="1fr 1fr" gap={16}>
        <Container style={{ padding: 20, borderRadius: 8 }}>
          <Flex flexDirection="column" gap={12}>
            <Flex justifyContent="space-between" alignItems="center">
              <Text style={{ fontWeight: 600 }}>Node CPU Usage</Text>
              {latestCPU !== null && (
                <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>
                  current: {latestCPU.toFixed(1)}%
                </Text>
              )}
            </Flex>
            {cpuSeries && cpuSeries.datapoints.length > 0 ? (
              <TimeseriesChart height={160}>
                <TimeseriesChart.Line data={cpuSeries} color={Colors.Charts.Categorical.Color02.Default} gapPolicy="connect" pointsDisplay="never" />
                <TimeseriesChart.YAxis label="%" />
                <TimeseriesChart.Legend />
              </TimeseriesChart>
            ) : (
              <Flex alignItems="center" justifyContent="center" style={{ height: 160 }}>
                <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>No data</Text>
              </Flex>
            )}
          </Flex>
        </Container>

        <Container style={{ padding: 20, borderRadius: 8 }}>
          <Flex flexDirection="column" gap={12}>
            <Flex justifyContent="space-between" alignItems="center">
              <Text style={{ fontWeight: 600 }}>Node Memory Usage</Text>
              {latestMem !== null && (
                <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>
                  current: {latestMem.toFixed(1)}%
                </Text>
              )}
            </Flex>
            {memSeries && memSeries.datapoints.length > 0 ? (
              <TimeseriesChart height={160}>
                <TimeseriesChart.Line data={memSeries} color={Colors.Charts.Categorical.Color01.Default} gapPolicy="connect" pointsDisplay="never" />
                <TimeseriesChart.YAxis label="%" />
                <TimeseriesChart.Legend />
              </TimeseriesChart>
            ) : (
              <Flex alignItems="center" justifyContent="center" style={{ height: 160 }}>
                <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>No data</Text>
              </Flex>
            )}
          </Flex>
        </Container>
      </Grid>

      {/* Network traffic chart */}
      <Container style={{ padding: 20, borderRadius: 8 }}>
        <Flex flexDirection="column" gap={12}>
          <Flex justifyContent="space-between" alignItems="center">
            <Text style={{ fontWeight: 600 }}>Node Network Traffic</Text>
            <Flex gap={16}>
              {latestNetIn !== null && (
                <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>
                  in: {formatBytes(latestNetIn)}
                </Text>
              )}
              {latestNetOut !== null && (
                <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>
                  out: {formatBytes(latestNetOut)}
                </Text>
              )}
            </Flex>
          </Flex>
          {netInSeries && netInSeries.datapoints.length > 0 ? (
            <TimeseriesChart height={160}>
              <TimeseriesChart.Line data={netInSeries} color={Colors.Charts.Categorical.Color03.Default} gapPolicy="connect" pointsDisplay="never" />
              <TimeseriesChart.Line data={netOutSeries!} color={Colors.Charts.Categorical.Color04.Default} gapPolicy="connect" pointsDisplay="never" />
              <TimeseriesChart.YAxis label="B/s" />
              <TimeseriesChart.Legend />
            </TimeseriesChart>
          ) : (
            <Flex alignItems="center" justifyContent="center" style={{ height: 160 }}>
              <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>No data</Text>
            </Flex>
          )}
        </Flex>
      </Container>

      {/* Stat tiles */}
      <Grid gridTemplateColumns="repeat(6, 1fr)" gap={16}>
        <Container style={{ padding: 20, borderRadius: 8 }}>
          <SingleValue label="Virtual Machines" data={`${runningVMs}/${totalVMs}`} height={100} />
        </Container>
        <Container style={{ padding: 20, borderRadius: 8 }}>
          <SingleValue label="Virt-Enabled Nodes" data={`${virtEnabledNodes}/${totalVirtNodes}`} height={100} />
        </Container>
        <Container style={{ padding: 20, borderRadius: 8 }}>
          <SingleValue
            label="Persistent Volumes"
            data={pvcResult.isLoading ? "…" : pvcRecords.length}
            height={100}
            color={pvcRecords.length > 0 ? Colors.Text.Success.Default : Colors.Text.Neutral.Subdued}
          />
        </Container>
        <Container style={{ padding: 20, borderRadius: 8 }}>
          <SingleValue
            label="VM Errors (1h)"
            data={errorCount}
            height={100}
            color={errorCount > 0 ? Colors.Text.Critical.Default : Colors.Text.Success.Default}
          />
        </Container>
        <Container style={{ padding: 20, borderRadius: 8 }}>
          <SingleValue
            label="Nodes with OneAgent"
            data={`${nodesWithAgent}/${virtEnabledNodes}`}
            height={100}
            color={virtEnabledNodes > 0 && nodesWithAgent === virtEnabledNodes
              ? Colors.Text.Success.Default
              : Colors.Text.Warning.Default}
          />
        </Container>
        <Container style={{ padding: 20, borderRadius: 8 }}>
          <SingleValue
            label="VMs with OneAgent"
            data={guestVMsResult.isLoading ? "…" : `${guestVMRecords.length}/${totalVMs}`}
            height={100}
            color={guestVMRecords.length > 0 && guestVMRecords.length === totalVMs
              ? Colors.Text.Success.Default
              : guestVMRecords.length > 0 ? Colors.Text.Warning.Default : Colors.Text.Neutral.Subdued}
          />
        </Container>
      </Grid>

    </Flex>
  );
};
