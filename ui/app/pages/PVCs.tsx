import React, { useMemo, useState } from "react";
import { Flex, Container } from "@dynatrace/strato-components/layouts";
import { Heading, Text, Paragraph } from "@dynatrace/strato-components/typography";
import { Colors } from "@dynatrace/strato-design-tokens";
import { useDql } from "@dynatrace-sdk/react-hooks";
import { DataTable } from "@dynatrace/strato-components-preview/tables";
import type { DataTableColumnDef } from "@dynatrace/strato-components-preview/tables";
import { TextInput } from "@dynatrace/strato-components-preview/forms";
import { ProgressCircle } from "@dynatrace/strato-components/content";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";

const ENV_URL = getEnvironmentUrl().replace(/\/$/, "");

/** Parse Kubernetes binary quantity strings (e.g. "10Gi", "500Mi") into human-readable form. */
const formatCapacity = (raw: string | null): string => {
  if (!raw) return "—";
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|Pi|K|M|G|T|P)?$/);
  if (!match) return raw;
  const value = parseFloat(match[1]);
  const unit = match[2] ?? "";
  const multipliers: Record<string, number> = {
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5,
    K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4, P: 1000 ** 5,
    "": 1,
  };
  const bytes = value * (multipliers[unit] ?? 1);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
};

interface PVCRecord extends Record<string, unknown> {
  pvc_id: string;
  pvc_name: string;
  namespace: string;
  image_endpoint: string | null;
  provisioner: string | null;
  phase: string | null;
  storage_class: string | null;
  capacity: string | null;
}

interface PVTraversalRecord {
  pvc_id: string;
  pv_name: string;
}

interface NamespaceRecord {
  namespace_name: string;
  namespace_id: string;
}

interface PVCUsageRecord {
  pvc_entity_id: string;
  usage_pct: number | null;
}

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

export const PVCs = () => {
  // Primary PVC query — parse k8s.object for namespace, phase, storage class, capacity
  const pvcResult = useDql({
    query: [
      'smartscapeNodes K8S_PERSISTENTVOLUMECLAIM',
      '| filter isNotNull(`tags:k8s.annotations`[`cdi.kubevirt.io/createdForDataVolume`])',
      '| fieldsAdd pvc_type = `tags:k8s.annotations`[`cdi.kubevirt.io/storage.contentType`]',
      '| filter pvc_type == "kubevirt"',
      '| parse k8s.object, "JSON:config"',
      '| fieldsAdd',
      '    phase = config[`status`][`phase`],',
      '    storage_class = config[`spec`][`storageClassName`],',
      '    capacity = config[`status`][`capacity`][`storage`],',
      '    ns_from_obj = config[`metadata`][`namespace`]',
      '| fieldsAdd namespace = coalesce(k8s.namespace.name, ns_from_obj)',
      '| fields',
      '    pvc_id = id,',
      '    pvc_name = name,',
      '    namespace,',
      '    image_endpoint = `tags:k8s.annotations`[`cdi.kubevirt.io/storage.import.endpoint`],',
      '    provisioner = `tags:k8s.annotations`[`volume.kubernetes.io/storage-provisioner`],',
      '    phase,',
      '    storage_class,',
      '    capacity',
    ].join('\n'),
  });

  // Query PVC usage % from kubelet metrics
  const pvcUsageResult = useDql({
    query: [
      'timeseries {',
      '  used = sum(dt.kubernetes.persistentvolumeclaim.used, rollup:sum, rate:1m),',
      '  cap = sum(dt.kubernetes.persistentvolumeclaim.capacity, rollup:sum, rate:1m)',
      '}, by: {dt.smartscape.k8s_persistentvolumeclaim},',
      'timeframe: timeframe(from: -10m, to: -2m),',
      'filter: isNotNull(dt.smartscape.k8s_persistentvolumeclaim)',
      '| fields',
      '    pvc_entity_id = `dt.smartscape.k8s_persistentvolumeclaim`,',
      '    usage_pct = if(arrayLast(cap) > 0,',
      '      round(arrayLast(used) / arrayLast(cap) * 100, decimals:1),',
      '      else: null)',
    ].join('\n'),
  });

  // Query all K8S_NAMESPACE entities to build a name→ID map for linking
  const nsQueryResult = useDql({
    query: 'smartscapeNodes K8S_NAMESPACE | fields namespace_name = k8s.namespace.name, namespace_id = id',
  });

  // Traverse PVC → PV to get the actual PV name
  const pvTraversalResult = useDql({
    query: [
      'smartscapeNodes K8S_PERSISTENTVOLUMECLAIM',
      '| filter isNotNull(`tags:k8s.annotations`[`cdi.kubevirt.io/createdForDataVolume`])',
      '| fieldsAdd pvc_type = `tags:k8s.annotations`[`cdi.kubevirt.io/storage.contentType`]',
      '| filter pvc_type == "kubevirt"',
      '| fieldsAdd pvc_id = id',
      '| traverse edgeTypes: {uses}, targetTypes: {K8S_PERSISTENTVOLUME}, fieldsKeep: {pvc_id}',
      '| fields pvc_id, pv_name = entity.name',
    ].join('\n'),
  });

  const rawPVCs = (pvcResult.data?.records ?? []) as unknown as PVCRecord[];
  const pvMap = new Map<string, string>();
  ((pvTraversalResult.data?.records ?? []) as unknown as PVTraversalRecord[]).forEach((r) => {
    pvMap.set(r.pvc_id, r.pv_name);
  });
  const nsMap = new Map<string, string>();
  ((nsQueryResult.data?.records ?? []) as unknown as NamespaceRecord[]).forEach((r) => {
    if (r.namespace_name) nsMap.set(r.namespace_name, r.namespace_id);
  });
  const usageMap = new Map<string, number | null>();
  ((pvcUsageResult.data?.records ?? []) as unknown as PVCUsageRecord[]).forEach((r) => {
    if (r.pvc_entity_id) usageMap.set(r.pvc_entity_id, r.usage_pct ?? null);
  });

  // Enrich PVCs with their PV name, namespace ID, and usage %
  const records: (PVCRecord & { pv_name: string | null; namespace_id: string | null; usage_pct: number | null })[] = rawPVCs.map((r) => ({
    ...r,
    pv_name: pvMap.get(r.pvc_id) ?? null,
    namespace_id: r.namespace ? (nsMap.get(r.namespace) ?? null) : null,
    usage_pct: usageMap.get(r.pvc_id) ?? null,
  }));

  // Facet state
  const [selectedNamespaces, setSelectedNamespaces] = useState<Set<string>>(new Set());
  const [selectedProvisioners, setSelectedProvisioners] = useState<Set<string>>(new Set());
  const [selectedPhases, setSelectedPhases] = useState<Set<string>>(new Set());
  const [selectedStorageClasses, setSelectedStorageClasses] = useState<Set<string>>(new Set());
  const [searchText, setSearchText] = useState("");

  const toggleFacet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (value: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  type EnrichedPVC = PVCRecord & { pv_name: string | null; namespace_id: string | null; usage_pct: number | null };

  const { namespaceOptions, provisionerOptions, phaseOptions, storageClassOptions, tableData } = useMemo(() => {
    const toCounts = (arr: EnrichedPVC[], key: keyof EnrichedPVC) => {
      const m = new Map<string, number>();
      arr.forEach((r) => {
        const v = (r[key] as string) ?? "";
        if (v) m.set(v, (m.get(v) ?? 0) + 1);
      });
      return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }));
    };

    const afterNamespace = selectedNamespaces.size === 0
      ? records
      : records.filter((r) => selectedNamespaces.has(r.namespace ?? ""));
    const afterProvisioner = selectedProvisioners.size === 0
      ? afterNamespace
      : afterNamespace.filter((r) => selectedProvisioners.has(r.provisioner ?? ""));
    const afterPhase = selectedPhases.size === 0
      ? afterProvisioner
      : afterProvisioner.filter((r) => selectedPhases.has(r.phase ?? ""));
    const afterStorageClass = selectedStorageClasses.size === 0
      ? afterPhase
      : afterPhase.filter((r) => selectedStorageClasses.has(r.storage_class ?? ""));
    const search = searchText.toLowerCase();
    const filtered = search
      ? afterStorageClass.filter((r) => Object.values(r).join(" ").toLowerCase().includes(search))
      : afterStorageClass;

    return {
      namespaceOptions: toCounts(records, "namespace"),
      provisionerOptions: toCounts(afterNamespace, "provisioner"),
      phaseOptions: toCounts(afterProvisioner, "phase"),
      storageClassOptions: toCounts(afterPhase, "storage_class"),
      tableData: filtered,
    };
  }, [records, selectedNamespaces, selectedProvisioners, selectedPhases, selectedStorageClasses, searchText]);

  const columns: DataTableColumnDef<EnrichedPVC>[] = [
    {
      id: "pvc_name",
      header: "PVC Name",
      accessor: "pvc_name",
      cell: ({ value, rowData }: { value: string; rowData: EnrichedPVC }) => {
        const url = `${ENV_URL}/ui/apps/dynatrace.kubernetes/smartscape/storage/K8S_PERSISTENTVOLUMECLAIM?perspective=Utilization&sort=healthIndicators%3Adescending&detailsId=${encodeURIComponent(rowData.pvc_id)}&sidebarOpen=false`;
        return (
          <a href={url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
            <Text style={{ fontWeight: 600, color: Colors.Text.Primary.Default }}>{value}</Text>
          </a>
        );
      },
    },
    {
      id: "namespace",
      header: "Namespace",
      accessor: "namespace",
      cell: ({ value, rowData }: { value: string; rowData: EnrichedPVC }) => {
        if (!value) return <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>—</Text>;
        if (rowData.namespace_id) {
          const url = `${ENV_URL}/ui/apps/dynatrace.kubernetes/smartscape/K8S_NAMESPACE?perspective=Health&sort=healthIndicators%3Adescending&detailsId=${encodeURIComponent(rowData.namespace_id)}&sidebarOpen=false`;
          return (
            <a href={url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
              <Text textStyle="small" style={{ color: Colors.Text.Primary.Default }}>{value}</Text>
            </a>
          );
        }
        return <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>{value}</Text>;
      },
      width: 140,
    },
    {
      id: "phase",
      header: "Status",
      accessor: "phase",
      cell: ({ value }: { value: string | null }) => {
        const phase = value ?? "Unknown";
        const isBound = phase === "Bound";
        return (
          <Flex alignItems="center" gap={6}>
            <span style={{
              width: 8, height: 8, borderRadius: "50%", flexShrink: 0, display: "inline-block",
              background: isBound
                ? Colors.Background.Container.Success.Default
                : Colors.Background.Container.Warning.Default,
            }} />
            <Text
              textStyle="small"
              style={{
                color: isBound ? Colors.Text.Success.Default : Colors.Text.Warning.Default,
                fontWeight: 600,
              }}
            >
              {phase}
            </Text>
          </Flex>
        );
      },
      width: 110,
    },
    {
      id: "provisioner",
      header: "Provisioner",
      accessor: "provisioner",
      cell: ({ value }: { value: string | null }) => (
        <Text textStyle="small" style={{ fontFamily: "monospace", color: Colors.Text.Neutral.Subdued }}>
          {value ?? "—"}
        </Text>
      ),
      width: 220,
    },
    {
      id: "pv_name",
      header: "Persistent Volume",
      accessor: "pv_name",
      cell: ({ value }: { value: string | null }) => (
        <Text textStyle="small" style={{ fontFamily: "monospace", color: Colors.Text.Neutral.Default }}>
          {value ?? "—"}
        </Text>
      ),
    },
    {
      id: "storage_class",
      header: "Storage Class",
      accessor: "storage_class",
      cell: ({ value }: { value: string | null }) => (
        <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>
          {value ?? "—"}
        </Text>
      ),
      width: 160,
    },
    {
      id: "capacity",
      header: "Capacity",
      accessor: "capacity",
      cell: ({ value }: { value: string | null }) => (
        <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>
          {formatCapacity(value)}
        </Text>
      ),
      width: 90,
    },
    {
      id: "usage_pct",
      header: "Usage %",
      accessor: "usage_pct",
      cell: ({ value }: { value: number | null }) => {
        if (value === null || value === undefined) {
          return <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>—</Text>;
        }
        const isRed = value >= 90;
        const isYellow = value >= 75 && value < 90;
        const color = isRed
          ? Colors.Text.Critical.Default
          : isYellow
          ? Colors.Text.Warning.Default
          : Colors.Text.Success.Default;
        const barColor = isRed
          ? Colors.Background.Container.Critical.Default
          : isYellow
          ? Colors.Background.Container.Warning.Default
          : Colors.Background.Container.Success.Default;
        return (
          <Flex flexDirection="column" gap={2}>
            <Text textStyle="small" style={{ color, fontWeight: isRed ? 700 : 600 }}>
              {value.toFixed(1)}%
            </Text>
            <div style={{ height: 4, borderRadius: 2, background: Colors.Background.Container.Neutral.Default, width: '100%' }}>
              <div style={{ height: 4, borderRadius: 2, background: barColor, width: `${Math.min(value, 100)}%` }} />
            </div>
          </Flex>
        );
      },
      width: 100,
    },
    {
      id: "image_endpoint",
      header: "Source Image",
      accessor: "image_endpoint",
      cell: ({ value }: { value: string | null }) => {
        if (!value) return <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>—</Text>;
        const filename = value.split("/").pop() ?? value;
        return (
          <Flex flexDirection="column" gap={2}>
            <Text textStyle="small" style={{ fontWeight: 600 }}>{filename}</Text>
            <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued, wordBreak: "break-all" }}>
              {value}
            </Text>
          </Flex>
        );
      },
    },
  ];

  if (pvcResult.isLoading || pvTraversalResult.isLoading || nsQueryResult.isLoading || pvcUsageResult.isLoading) {
    return (
      <Flex alignItems="center" justifyContent="center" style={{ height: 300 }}>
        <ProgressCircle />
      </Flex>
    );
  }

  const namespaceCount = new Set(records.map((r) => r.namespace).filter(Boolean)).size;

  return (
    <Flex flexDirection="column" padding={32} gap={24}>
      <Flex flexDirection="column" gap={4}>
        <Heading level={1}>Persistent Volume Claims</Heading>
        <Paragraph style={{ color: Colors.Text.Neutral.Subdued }}>
          KubeVirt DataVolume-backed PVCs detected via Smartscape
        </Paragraph>
      </Flex>

      {/* Summary */}
      <Flex gap={12}>
        <Container style={{ padding: "12px 20px", borderRadius: 8, borderLeft: `4px solid ${Colors.Border.Success.Default}` }}>
          <Flex flexDirection="column" gap={2}>
            <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>Total PVCs</Text>
            <Heading level={2} style={{ margin: 0 }}>{records.length}</Heading>
          </Flex>
        </Container>
        <Container style={{ padding: "12px 20px", borderRadius: 8, borderLeft: `4px solid ${Colors.Border.Primary.Default}` }}>
          <Flex flexDirection="column" gap={2}>
            <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>Namespaces</Text>
            <Heading level={2} style={{ margin: 0 }}>{namespaceCount}</Heading>
          </Flex>
        </Container>
        <Container style={{ padding: "12px 20px", borderRadius: 8, borderLeft: `4px solid ${Colors.Border.Neutral.Default}` }}>
          <Flex flexDirection="column" gap={2}>
            <Text textStyle="small" style={{ color: Colors.Text.Neutral.Subdued }}>Bound PVs</Text>
            <Heading level={2} style={{ margin: 0 }}>{records.filter((r) => r.phase === "Bound").length}</Heading>
          </Flex>
        </Container>
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
          <FacetSection title="Namespace" options={namespaceOptions} selected={selectedNamespaces} onToggle={toggleFacet(setSelectedNamespaces)} />
          <FacetSection title="Provisioner" options={provisionerOptions} selected={selectedProvisioners} onToggle={toggleFacet(setSelectedProvisioners)} />
          <FacetSection title="Status" options={phaseOptions} selected={selectedPhases} onToggle={toggleFacet(setSelectedPhases)} />
          <FacetSection title="Storage Class" options={storageClassOptions} selected={selectedStorageClasses} onToggle={toggleFacet(setSelectedStorageClasses)} />
          {(selectedNamespaces.size > 0 || selectedProvisioners.size > 0 || selectedPhases.size > 0 || selectedStorageClasses.size > 0) && (
            <button
              onClick={() => { setSelectedNamespaces(new Set()); setSelectedProvisioners(new Set()); setSelectedPhases(new Set()); setSelectedStorageClasses(new Set()); }}
              style={{ background: "transparent", border: "none", cursor: "pointer", padding: "4px 8px", textAlign: "left" }}
            >
              <Text textStyle="small" style={{ color: Colors.Text.Primary.Default }}>Clear filters</Text>
            </button>
          )}
        </Flex>

        {/* Table */}
        <Flex flexDirection="column" style={{ flex: 1, minWidth: 0 }}>
          <DataTable data={tableData} columns={columns} sortable resizable>
            <DataTable.TableActions>
              <TextInput
                placeholder="Filter PVCs, namespaces, volumes..."
                value={searchText}
                onChange={(value: string) => setSearchText(value)}
              />
            </DataTable.TableActions>
            <DataTable.EmptyState>No KubeVirt PVCs found</DataTable.EmptyState>
          </DataTable>
        </Flex>
      </Flex>
    </Flex>
  );
};
