import React, { useMemo, useState } from "react";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Text, Paragraph } from "@dynatrace/strato-components/typography";
import { Colors } from "@dynatrace/strato-design-tokens";
import { useDql } from "@dynatrace-sdk/react-hooks";
import { DataTable } from "@dynatrace/strato-components-preview/tables";
import type { DataTableColumnDef } from "@dynatrace/strato-components-preview/tables";
import { ProgressCircle } from "@dynatrace/strato-components/content";
import { TextInput } from "@dynatrace/strato-components-preview/forms";
import { Sheet } from "@dynatrace/strato-components/overlays";
import { Button } from "@dynatrace/strato-components/buttons";

const LEVEL_COLORS: Record<string, string> = {
  ERROR: Colors.Text.Critical.Default,
  WARN: Colors.Text.Warning.Default,
  INFO: Colors.Text.Neutral.Default,
  DEBUG: Colors.Text.Neutral.Subdued,
};

interface LogRecord extends Record<string, unknown> {
  timestamp: string;
  "k8s.pod.name": string;
  "k8s.node.name": string;
  "k8s.namespace.name": string;
  loglevel: string;
  content: string;
}

const LevelBadge = ({ level }: { level: string }) => (
  <Text
    textStyle="small"
    style={{
      fontFamily: "monospace",
      color: LEVEL_COLORS[level] ?? Colors.Text.Neutral.Subdued,
      fontWeight: level === "ERROR" ? 700 : undefined,
      textTransform: "uppercase",
      minWidth: 50,
    }}
  >
    {level || "—"}
  </Text>
);

/** Extract the KubeVirt VM name from a virt-launcher pod name. */
const getVMName = (podName: string): string => {
  const withoutPrefix = podName.replace(/^virt-launcher-/, "");
  const parts = withoutPrefix.split("-");
  return parts.length > 1 ? parts.slice(0, -1).join("-") : withoutPrefix;
};

const parseContent = (content: string): string => {
  try {
    const parsed = JSON.parse(content);
    return parsed.msg ?? parsed.message ?? content;
  } catch {
    return content;
  }
};

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

export const Logs = () => {
  const result = useDql({
    query: `fetch logs
| filter matchesPhrase(k8s.pod.name, "virt-launcher")
| sort timestamp desc
| limit 500
| fields timestamp, k8s.pod.name, k8s.node.name, k8s.namespace.name, loglevel, content`,
  });

  const allRecords = (result.data?.records ?? []) as unknown as LogRecord[];

  // Facet state
  const [selectedLevels, setSelectedLevels] = useState<Set<string>>(new Set());
  const [selectedNamespaces, setSelectedNamespaces] = useState<Set<string>>(new Set());
  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set());
  const [searchText, setSearchText] = useState("");

  const toggleFacet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (value: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const { levelOptions, namespaceOptions, nodeOptions, tableData } = useMemo(() => {
    const toCounts = (arr: LogRecord[], key: keyof LogRecord) => {
      const m = new Map<string, number>();
      arr.forEach((r) => {
        const v = r[key] as string;
        if (v) m.set(v, (m.get(v) ?? 0) + 1);
      });
      return Array.from(m.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([value, count]) => ({ value, count }));
    };

    const afterLevel = selectedLevels.size === 0
      ? allRecords
      : allRecords.filter((r) => selectedLevels.has(r.loglevel));
    const afterNamespace = selectedNamespaces.size === 0
      ? afterLevel
      : afterLevel.filter((r) => selectedNamespaces.has(r["k8s.namespace.name"]));
    const afterNode = selectedNodes.size === 0
      ? afterNamespace
      : afterNamespace.filter((r) => selectedNodes.has(r["k8s.node.name"]));
    const search = searchText.toLowerCase();
    const filtered = search
      ? afterNode.filter((r) =>
          [r["k8s.pod.name"], r["k8s.node.name"], r["k8s.namespace.name"], r.content]
            .join(" ").toLowerCase().includes(search)
        )
      : afterNode;

    return {
      levelOptions: toCounts(allRecords, "loglevel"),
      namespaceOptions: toCounts(afterLevel, "k8s.namespace.name"),
      nodeOptions: toCounts(afterNamespace, "k8s.node.name"),
      tableData: filtered,
    };
  }, [allRecords, selectedLevels, selectedNamespaces, selectedNodes, searchText]);

  const hasFilters = selectedLevels.size > 0 || selectedNamespaces.size > 0 || selectedNodes.size > 0;

  const [selectedLog, setSelectedLog] = useState<LogRecord | null>(null);

  const prettyContent = (content: string): string => {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  };

  const columns: DataTableColumnDef<LogRecord>[] = [
    {
      id: "timestamp",
      header: "Time",
      accessor: (row: LogRecord) => row.timestamp,
      cell: ({ value }: { value: string }) => (
        <Text
          textStyle="small"
          style={{ fontFamily: "monospace", color: Colors.Text.Neutral.Subdued, whiteSpace: "nowrap" }}
        >
          {value ? new Date(value).toLocaleString() : "—"}
        </Text>
      ),
      width: 170,
    },
    {
      id: "level",
      header: "Level",
      accessor: (row: LogRecord) => row.loglevel,
      cell: ({ value }: { value: string }) => <LevelBadge level={value} />,
      width: 70,
    },
    {
      id: "vm",
      header: "VM",
      accessor: (row: LogRecord) => row["k8s.pod.name"],
      cell: ({ value }: { value: string }) => (
        <Flex flexDirection="column" gap={2}>
          <Text style={{ fontWeight: 600 }}>{value ? getVMName(value) : "—"}</Text>
          <Text textStyle="small" style={{ fontFamily: "monospace", color: Colors.Text.Neutral.Subdued }}>
            {value}
          </Text>
        </Flex>
      ),
      minWidth: 180,
    },
    {
      id: "node",
      header: "Node",
      accessor: (row: LogRecord) => row["k8s.node.name"],
      cell: ({ value }: { value: string }) => (
        <Text
          textStyle="small"
          style={{
            fontFamily: "monospace",
            color: Colors.Text.Primary.Default,
            whiteSpace: "nowrap",
          }}
        >
          {value || "—"}
        </Text>
      ),
      minWidth: 160,
    },
    {
      id: "message",
      header: "Message",
      accessor: (row: LogRecord) => parseContent(row.content),
      cell: ({ value, rowData }: { value: string; rowData: LogRecord }) => (
        <Text
          textStyle="small"
          style={{
            color: LEVEL_COLORS[rowData.loglevel] ?? Colors.Text.Neutral.Default,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "block",
            cursor: "pointer",
          }}
          title="Click to expand"
          onClick={() => setSelectedLog(rowData)}
        >
          {value}
        </Text>
      ),
    },
  ];

  return (
    <Flex flexDirection="column" padding={32} gap={24}>
      <Flex flexDirection="column" gap={4}>
        <Heading level={1}>VM Logs</Heading>
        <Paragraph style={{ color: Colors.Text.Neutral.Subdued }}>
          Recent logs from KubeVirt virt-launcher pods across all nodes
        </Paragraph>
      </Flex>

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
          <FacetSection
            title="Level"
            options={levelOptions}
            selected={selectedLevels}
            onToggle={toggleFacet(setSelectedLevels)}
          />
          <FacetSection
            title="Namespace"
            options={namespaceOptions}
            selected={selectedNamespaces}
            onToggle={toggleFacet(setSelectedNamespaces)}
          />
          <FacetSection
            title="Node"
            options={nodeOptions}
            selected={selectedNodes}
            onToggle={toggleFacet(setSelectedNodes)}
          />
          {hasFilters && (
            <button
              onClick={() => {
                setSelectedLevels(new Set());
                setSelectedNamespaces(new Set());
                setSelectedNodes(new Set());
              }}
              style={{ background: "transparent", border: "none", cursor: "pointer", padding: "4px 8px", textAlign: "left" }}
            >
              <Text textStyle="small" style={{ color: Colors.Text.Primary.Default }}>Clear filters</Text>
            </button>
          )}
        </Flex>

        {/* Table */}
        <Flex flexDirection="column" style={{ flex: 1, minWidth: 0, overflowX: "auto" }}>
          {result.isLoading ? (
            <Flex alignItems="center" justifyContent="center" style={{ height: 300 }}>
              <ProgressCircle />
            </Flex>
          ) : (
            <DataTable data={tableData} columns={columns} resizable>
              <DataTable.TableActions>
                <TextInput
                  placeholder="Filter pods, nodes, messages..."
                  value={searchText}
                  onChange={(value: string) => setSearchText(value)}
                />
              </DataTable.TableActions>
              <DataTable.EmptyState>No logs found</DataTable.EmptyState>
            </DataTable>
          )}
        </Flex>
      </Flex>

      <Sheet
        title={selectedLog ? `${getVMName(selectedLog["k8s.pod.name"])} — ${new Date(selectedLog.timestamp).toLocaleString()}` : ""}
        show={selectedLog !== null}
        onDismiss={() => setSelectedLog(null)}
        actions={
          <Button onClick={() => setSelectedLog(null)}>Close</Button>
        }
      >
        {selectedLog && (
          <Flex flexDirection="column" gap={16}>
            {/* Metadata grid */}
            <Flex flexDirection="column" gap={6}>
              {[
                ["Level", <LevelBadge key="level" level={selectedLog.loglevel} />],
                ["VM", <Text key="vm" style={{ fontWeight: 600 }}>{getVMName(selectedLog["k8s.pod.name"])}</Text>],
                ["Pod", <Text key="pod" textStyle="small" style={{ fontFamily: "monospace" }}>{selectedLog["k8s.pod.name"]}</Text>],
                ["Node", <Text key="node" textStyle="small" style={{ fontFamily: "monospace" }}>{selectedLog["k8s.node.name"] || "—"}</Text>],
                ["Namespace", <Text key="ns" textStyle="small">{selectedLog["k8s.namespace.name"] || "—"}</Text>],
                ["Time", <Text key="ts" textStyle="small" style={{ fontFamily: "monospace" }}>{new Date(selectedLog.timestamp).toLocaleString()}</Text>],
              ].map(([label, content]) => (
                <Flex key={String(label)} gap={12} alignItems="center">
                  <Text
                    textStyle="small"
                    style={{ color: Colors.Text.Neutral.Subdued, width: 90, flexShrink: 0, fontWeight: 600, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.05em" }}
                  >
                    {label}
                  </Text>
                  {content}
                </Flex>
              ))}
            </Flex>

            {/* Divider */}
            <div style={{ borderTop: `1px solid ${Colors.Border.Neutral.Default}` }} />

            {/* Full message */}
            <Flex flexDirection="column" gap={6}>
              <Text
                textStyle="small"
                style={{ color: Colors.Text.Neutral.Subdued, fontWeight: 600, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.05em" }}
              >
                Raw Content
              </Text>
              <pre
                style={{
                  margin: 0,
                  padding: 12,
                  borderRadius: 4,
                  background: Colors.Background.Surface.Default,
                  border: `1px solid ${Colors.Border.Neutral.Default}`,
                  fontSize: 12,
                  fontFamily: "monospace",
                  color: LEVEL_COLORS[selectedLog.loglevel] ?? Colors.Text.Neutral.Default,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  overflowY: "auto",
                  maxHeight: 400,
                }}
              >
                {prettyContent(selectedLog.content)}
              </pre>
            </Flex>
          </Flex>
        )}
      </Sheet>
    </Flex>
  );
};
