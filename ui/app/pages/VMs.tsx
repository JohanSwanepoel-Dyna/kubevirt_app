import React, { useMemo, useState } from "react";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Text, Paragraph } from "@dynatrace/strato-components/typography";
import { Colors } from "@dynatrace/strato-design-tokens";
import { useDql } from "@dynatrace-sdk/react-hooks";
import { DataTable } from "@dynatrace/strato-components-preview/tables";
import type { DataTableColumnDef } from "@dynatrace/strato-components-preview/tables";
import { TextInput } from "@dynatrace/strato-components-preview/forms";
import { ProgressCircle } from "@dynatrace/strato-components/content";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";

const ENV_URL = getEnvironmentUrl().replace(/\/$/, "");

interface VMRecord extends Record<string, unknown> {
  "k8s.pod.name": string;
  "k8s.node.name": string;
  "k8s.namespace.name": string;
  "k8s.cluster.name": string;
  "k8s.pod.phase": string;
  vmLabel: string;
  podId: string;
  nsId: string;
  count: string;
  errorCount: string;
  warnCount: string;
  lastSeen: string;
}

/** Extract the KubeVirt VM name from a virt-launcher pod name. */
const getVMName = (podName: string): string => {
  const withoutPrefix = podName.replace(/^virt-launcher-/, "");
  const parts = withoutPrefix.split("-");
  return parts.length > 1 ? parts.slice(0, -1).join("-") : withoutPrefix;
};

const StatusDot = ({ errors }: { errors: number }) => (
  <span
    style={{
      display: "inline-block",
      width: 10,
      height: 10,
      borderRadius: "50%",
      background:
        errors > 0
          ? Colors.Background.Container.Critical.Accent
          : Colors.Background.Container.Success.Accent,
      flexShrink: 0,
    }}
  />
);

const FacetSection = ({
  title,
  options,
  selected,
  onToggle,
}: {
  title: string;
  options: Array<{ value: string; count: number }>;
  selected: Set<string>;
  onToggle: (value: string) => void;
}) => (
  <Flex flexDirection="column" gap={0} style={{ marginBottom: 16 }}>
    <Text
      textStyle="small"
      style={{
        fontWeight: 700,
        color: Colors.Text.Neutral.Subdued,
        padding: "6px 8px 4px",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        fontSize: 10,
      }}
    >
      {title}
    </Text>
    {options.map(({ value, count }) => {
      const active = selected.has(value);
      return (
        <button
          key={value}
          onClick={() => onToggle(value)}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            background: active ? Colors.Background.Container.Primary.Default : "transparent",
            border: "none",
            borderRadius: 4,
            padding: "4px 8px",
            cursor: "pointer",
            width: "100%",
            textAlign: "left",
          }}
        >
          <Text
            textStyle="small"
            style={{
              color: active ? Colors.Text.Primary.Default : Colors.Text.Neutral.Default,
              fontWeight: active ? 600 : undefined,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {value || "(unknown)"}
          </Text>
          <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued, flexShrink: 0 }}>
            {count}
          </Text>
        </button>
      );
    })}
    {options.length === 0 && (
      <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued, padding: "4px 8px" }}>—</Text>
    )}
  </Flex>
);

export const VMs = () => {

  // Primary source: smartscape pods with phase
  // Use the kubevirt.io label for precise filtering and vm.kubevirt.io/name for the actual VM name
  const podsResult = useDql({
    query: `smartscapeNodes K8S_POD
| filter \`tags:k8s.labels\`[kubevirt.io] == "virt-launcher"
| filter isNull(k8s.pod.deletion_timestamp)
| filter in(k8s.pod.phase, "Running", "Pending", "Unknown")
| fieldsAdd vmLabel = \`tags:k8s.labels\`[\`vm.kubevirt.io/name\`]
| fieldsAdd nsId = arrayFirst(toArray(references[belongs_to.k8s_namespace]))
| fields id, k8s.pod.name, k8s.node.name, k8s.namespace.name, k8s.cluster.name, k8s.pod.phase, vmLabel, nsId`,
  });

  // Log counts for error/warn enrichment
  const logsResult = useDql({
    query: `fetch logs, from:now()-1h
| filter matchesPhrase(k8s.pod.name, "virt-launcher")
| summarize
    count=count(),
    errorCount=countIf(loglevel=="ERROR"),
    warnCount=countIf(loglevel=="WARN"),
    lastSeen=max(timestamp),
  by:{k8s.pod.name}`,
  });

  // Node → host (OneAgent) relationship via smartscape traverse
  // K8S_NODE --runs_on--> HOST (belongs_to goes to K8S_CLUSTER, not HOST)
  const nodesResult = useDql({
    query: `smartscapeNodes K8S_NODE
| traverse edgeTypes: {runs_on}, targetTypes: {HOST}, fieldsKeep: {k8s.node.name}
| fields nodeName = k8s.node.name, hostId = id`,
  });

  // Guest VMs: HOST entities running on KVM hypervisors (OneAgent inside the guest VM)
  // Use `name` not `entity.name` — entity.name is empty for these hosts; `name` = the hostname reported by OneAgent (e.g. "vm1")
  const guestVMsResult = useDql({
    query: `smartscapeNodes HOST
| filter hypervisor.type == "HYPERVISOR_TYPE_KVM"
| fields name, id`,
  });

  // KubeVirt PVCs keyed by VMI name
  const pvcResult = useDql({
    query: [
      'smartscapeNodes K8S_PERSISTENTVOLUMECLAIM',
      '| filter isNotNull(`tags:k8s.annotations`[`cdi.kubevirt.io/createdForDataVolume`])',
      '| fieldsAdd pvc_type = `tags:k8s.annotations`[`cdi.kubevirt.io/storage.contentType`]',
      '| filter pvc_type == "kubevirt"',
      '| fieldsAdd vmi = `tags:k8s.annotations`[`cdi.kubevirt.io/createdForVMI`]',
      '| fields name, k8s.namespace.name, vmi',
    ].join('\n'),
  });

  // Merge: pods (primary) + log counts (enrichment)
  type PodRecord = { id: string; "k8s.pod.name": string; "k8s.node.name": string; "k8s.namespace.name": string; "k8s.cluster.name": string; "k8s.pod.phase": string; vmLabel: string; nsId: string };
  type LogRecord = { "k8s.pod.name": string; count: string; errorCount: string; warnCount: string; lastSeen: string };
  const podRecords = (podsResult.data?.records ?? []) as PodRecord[];
  const logMap = new Map<string, LogRecord>();
  ((logsResult.data?.records ?? []) as LogRecord[]).forEach((l) => logMap.set(l["k8s.pod.name"], l));

  const enrichedRecords: VMRecord[] = podRecords.map((p) => {
    const logs = logMap.get(p["k8s.pod.name"]);
    return {
      "k8s.pod.name": p["k8s.pod.name"],
      "k8s.node.name": p["k8s.node.name"] ?? "",
      "k8s.namespace.name": p["k8s.namespace.name"] ?? "",
      "k8s.cluster.name": p["k8s.cluster.name"] ?? "",
      "k8s.pod.phase": p["k8s.pod.phase"],
      vmLabel: p.vmLabel ?? getVMName(p["k8s.pod.name"]),
      podId: p.id ?? "",
      nsId: p.nsId ?? "",
      count: logs?.count ?? "0",
      errorCount: logs?.errorCount ?? "0",
      warnCount: logs?.warnCount ?? "0",
      lastSeen: logs?.lastSeen ?? "",
    };
  });

  // Facet state
  const [selectedClusters, setSelectedClusters] = useState<Set<string>>(new Set());
  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set());
  const [selectedNamespaces, setSelectedNamespaces] = useState<Set<string>>(new Set());
  const [searchText, setSearchText] = useState("");

  const toggleFacet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (value: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };
  const toggleCluster = (value: string) => {
    toggleFacet(setSelectedClusters)(value);
    setSelectedNodes(new Set());
    setSelectedNamespaces(new Set());
  };
  const toggleNode = (value: string) => {
    toggleFacet(setSelectedNodes)(value);
    setSelectedNamespaces(new Set());
  };
  const toggleNamespace = toggleFacet(setSelectedNamespaces);

  const { clusterOptions, nodeOptions, namespaceOptions, tableData } = useMemo(() => {
    const afterCluster = selectedClusters.size === 0
      ? enrichedRecords
      : enrichedRecords.filter((r) => selectedClusters.has(r["k8s.cluster.name"]));
    const afterNode = selectedNodes.size === 0
      ? afterCluster
      : afterCluster.filter((r) => selectedNodes.has(r["k8s.node.name"]));
    const afterNamespace = selectedNamespaces.size === 0
      ? afterNode
      : afterNode.filter((r) => selectedNamespaces.has(r["k8s.namespace.name"]));
    const search = searchText.toLowerCase();
    const filtered = search
      ? afterNamespace.filter((r) => Object.values(r).join(" ").toLowerCase().includes(search))
      : afterNamespace;

    const toCounts = (arr: VMRecord[], key: keyof VMRecord) => {
      const m = new Map<string, number>();
      arr.forEach((r) => { const v = r[key] as string; if (v) m.set(v, (m.get(v) ?? 0) + 1); });
      return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }));
    };

    return {
      clusterOptions: toCounts(enrichedRecords, "k8s.cluster.name"),
      nodeOptions: toCounts(afterCluster, "k8s.node.name"),
      namespaceOptions: toCounts(afterNode, "k8s.namespace.name"),
      tableData: filtered,
    };
  }, [enrichedRecords, selectedClusters, selectedNodes, selectedNamespaces, searchText]);

  type NodeInfo = { hasAgent: boolean; hostId: string | null };
  const nodeHostMap = new Map<string, NodeInfo>();
  ((nodesResult.data?.records ?? []) as Array<{ nodeName: string; hostId: string }>).forEach((n) => {
    nodeHostMap.set(n.nodeName, {
      hasAgent: !!n.hostId,
      hostId: n.hostId ?? null,
    });
  });

  // Map: lowercase VM hostname → guest HOST entity ID (for guest OneAgent detection)
  const guestVMMap = new Map<string, string>();
  ((guestVMsResult.data?.records ?? []) as Array<{ name: string; id: string }>).forEach((g) => {
    guestVMMap.set((g.name ?? "").toLowerCase(), g.id);
  });

  // Group PVCs by VMI name
  type PVCRec = { name: string; "k8s.namespace.name": string; vmi: string };
  const pvcsByVMI = new Map<string, string[]>();
  ((pvcResult.data?.records ?? []) as PVCRec[]).forEach((p) => {
    const key = p.vmi ?? "";
    if (!key) return;
    if (!pvcsByVMI.has(key)) pvcsByVMI.set(key, []);
    pvcsByVMI.get(key)!.push(p.name);
  });

  const columns: DataTableColumnDef<VMRecord>[] = [
    {
      id: "status",
      header: "Status",
      accessor: (row: VMRecord) => row["k8s.pod.phase"],
      cell: ({ value }: { value: string }) => (
        <Flex alignItems="center" gap={6}>
          <StatusDot errors={value === "Running" ? 0 : 1} />
          <Text textStyle="small">{value}</Text>
        </Flex>
      ),
      width: 130,
    },
    {
      id: "vm",
      header: "VM",
      accessor: (row: VMRecord) => row.vmLabel,
      minWidth: 160,
      cell: ({ value }: { value: string }) => {
        const guestHostId = guestVMMap.get(value.toLowerCase());
        return (
          <Flex alignItems="center" gap={8}>
            {guestHostId ? (
              <a
                href={`${ENV_URL}/ui/apps/dynatrace.infraops/explorer/Hosts?perspective=Health&sort=healthIndicators%3Adescending&fullPageId=${guestHostId}`}
                target="_blank"
                rel="noreferrer"
                style={{ fontWeight: 600, color: Colors.Text.Primary.Default, textDecoration: "none" }}
              >
                {value}
              </a>
            ) : (
              <Text style={{ fontWeight: 600 }}>{value}</Text>
            )}
            {guestHostId && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: Colors.Text.Success.Default,
                  background: Colors.Background.Container.Success.Default,
                  padding: "1px 6px",
                  borderRadius: 3,
                  flexShrink: 0,
                }}
              >
                OneAgent
              </span>
            )}
          </Flex>
        );
      },
    },
    {
      id: "pod",
      header: "Pod",
      accessor: (row: VMRecord) => row["k8s.pod.name"],
      minWidth: 200,
      cell: ({ value, rowData }: { value: string; rowData: VMRecord }) => (
        <Text textStyle="small" style={{ fontFamily: "monospace" }}>
          {rowData.podId ? (
            <a
              href={`${ENV_URL}/ui/apps/dynatrace.kubernetes/smartscape/workload/K8S_POD?perspective=Health&sort=healthIndicators%3Adescending&detailsId=${rowData.podId}&sidebarOpen=false`}
              target="_blank"
              rel="noreferrer"
              style={{ color: Colors.Text.Primary.Default, textDecoration: "none" }}
            >
              {value}
            </a>
          ) : value}
        </Text>
      ),
    },
    {
      id: "node",
      header: "Node",
      accessor: (row: VMRecord) => row["k8s.node.name"],
      minWidth: 220,
      cell: ({ value, rowData }: { value: string; rowData: VMRecord }) => {
        const info = nodeHostMap.get(value);
        const guestHostId = guestVMMap.get(rowData.vmLabel.toLowerCase());
        return (
          <Flex flexDirection="column" gap={2}>
            <Flex alignItems="center" gap={6}>
              {info?.hostId ? (
                <a
                  href={`${ENV_URL}/ui/apps/dynatrace.infraops/explorer/Hosts?perspective=Health&sort=healthIndicators%3Adescending&fullPageId=${info.hostId}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 13, fontFamily: "monospace", color: Colors.Text.Primary.Default, textDecoration: "none" }}
                >
                  {value}
                </a>
              ) : (
                <Text textStyle="small" style={{ fontFamily: "monospace", color: Colors.Text.Primary.Default }}>
                  {value}
                </Text>
              )}
              {info?.hasAgent && (
                <span style={{ fontSize: 10, fontWeight: 600, color: Colors.Text.Success.Default, background: Colors.Background.Container.Success.Default, padding: "1px 6px", borderRadius: 3 }}>
                  OneAgent
                </span>
              )}

            </Flex>
          </Flex>
        );
      },
    },
    {
      id: "namespace",
      header: "Namespace",
      accessor: (row: VMRecord) => row["k8s.namespace.name"],
      cell: ({ value, rowData }: { value: string; rowData: VMRecord }) => (
        rowData.nsId ? (
          <a
            href={`${ENV_URL}/ui/apps/dynatrace.kubernetes/smartscape/K8S_NAMESPACE?perspective=Health&sort=healthIndicators%3Adescending&detailsId=${rowData.nsId}&sidebarOpen=false`}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 13, color: Colors.Text.Primary.Default, textDecoration: "none" }}
          >
            {value}
          </a>
        ) : (
          <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>{value}</Text>
        )
      ),
      width: 120,
    },
    {
      id: "errors",
      header: "Errors",
      accessor: (row: VMRecord) => parseInt(row.errorCount, 10),
      cell: ({ value }: { value: number }) => (
        <Text
          textStyle="small"
          style={{
            color: value > 0 ? Colors.Text.Critical.Default : Colors.Text.Neutral.Subdued,
            fontWeight: value > 0 ? 600 : undefined,
          }}
        >
          {value}
        </Text>
      ),
      width: 80,
    },
    {
      id: "warnings",
      header: "Warnings",
      accessor: (row: VMRecord) => parseInt(row.warnCount ?? "0", 10),
      cell: ({ value }: { value: number }) => (
        <Text
          textStyle="small"
          style={{
            color: value > 0 ? Colors.Text.Warning.Default : Colors.Text.Neutral.Subdued,
          }}
        >
          {value}
        </Text>
      ),
      width: 90,
    },
    {
      id: "logs",
      header: "Total Logs",
      accessor: (row: VMRecord) => parseInt(row.count, 10),
      cell: ({ value }: { value: number }) => (
        <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>
          {value.toLocaleString()}
        </Text>
      ),
      width: 100,
    },
    {
      id: "lastSeen",
      header: "Last Log",
      accessor: "lastSeen",
      cell: ({ value }: { value: string }) => (
        <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>
          {value ? new Date(value).toLocaleString() : "—"}
        </Text>
      ),
      width: 180,
    },
    {
      id: "pvcs",
      header: "Bound PVCs",
      accessor: (row: VMRecord) => row.vmLabel,
      cell: ({ value }: { value: string }) => {
        const pvcs = pvcsByVMI.get(value) ?? [];
        if (pvcs.length === 0) {
          return <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>—</Text>;
        }
        return (
          <Flex gap={4} flexWrap="wrap">
            {pvcs.map((pvc) => (
              <span
                key={pvc}
                style={{
                  fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 3,
                  color: Colors.Text.Primary.Default,
                  background: Colors.Background.Container.Primary.Default,
                }}
              >
                {pvc}
              </span>
            ))}
          </Flex>
        );
      },
    },
  ];

  if (podsResult.isLoading || logsResult.isLoading || nodesResult.isLoading || pvcResult.isLoading || guestVMsResult.isLoading) {
    return (
      <Flex alignItems="center" justifyContent="center" style={{ height: 300 }}>
        <ProgressCircle />
      </Flex>
    );
  }

  return (
    <Flex flexDirection="column" padding={32} gap={24}>
      <Flex flexDirection="column" gap={4}>
        <Heading level={1}>Virtual Machines</Heading>
        <Paragraph style={{ color: Colors.Text.Neutral.Subdued }}>
          Currently running KubeVirt VMs (last 15m) and their Kubernetes node placement
        </Paragraph>
      </Flex>

      {/* Facet sidebar + table */}
      <Flex gap={24} alignItems="flex-start">
        {/* Facet sidebar */}
        <Flex
          flexDirection="column"
          style={{
            width: 200,
            flexShrink: 0,
            borderRight: `1px solid ${Colors.Border.Neutral.Default}`,
            paddingRight: 16,
          }}
        >
          <FacetSection title="Cluster" options={clusterOptions} selected={selectedClusters} onToggle={toggleCluster} />
          <FacetSection title="Node" options={nodeOptions} selected={selectedNodes} onToggle={toggleNode} />
          <FacetSection title="Namespace" options={namespaceOptions} selected={selectedNamespaces} onToggle={toggleNamespace} />
          {(selectedClusters.size > 0 || selectedNodes.size > 0 || selectedNamespaces.size > 0) && (
            <button
              onClick={() => { setSelectedClusters(new Set()); setSelectedNodes(new Set()); setSelectedNamespaces(new Set()); }}
              style={{ background: "transparent", border: "none", cursor: "pointer", padding: "4px 8px", textAlign: "left" }}
            >
              <Text textStyle="small" style={{ color: Colors.Text.Primary.Default }}>Clear filters</Text>
            </button>
          )}
        </Flex>

        {/* Table */}
        <Flex flexDirection="column" style={{ flex: 1, minWidth: 0 }}>
          <DataTable
            data={tableData}
            columns={columns}
            sortable
            resizable
          >
            <DataTable.TableActions>
              <TextInput
                placeholder="Filter VMs, nodes, namespaces..."
                value={searchText}
                onChange={(value: string) => setSearchText(value)}
              />
            </DataTable.TableActions>
            <DataTable.EmptyState>No VMs found</DataTable.EmptyState>
          </DataTable>
        </Flex>
      </Flex>
    </Flex>
  );
};
