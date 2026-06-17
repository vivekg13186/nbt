import { useEffect, useState } from "react";
import {
  App as AntApp,
  Button,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
} from "antd";
import { Clock, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useStore } from "../store";
import { api } from "../api";
import type { Schedule } from "../types";

const PRESETS: [string, string][] = [
  ["Every minute", "* * * * *"],
  ["Every 15 min", "*/15 * * * *"],
  ["Hourly", "0 * * * *"],
  ["Daily 09:00", "0 9 * * *"],
  ["Weekdays 09:00", "0 9 * * 1-5"],
  ["Weekly (Mon)", "0 9 * * 1"],
  ["Monthly (1st)", "0 0 1 * *"],
];

const statusColor: Record<string, string> = {
  passed: "success",
  failed: "error",
  error: "error",
  running: "processing",
  cancelled: "warning",
};

function fmt(ts: number | null) {
  return ts ? new Date(ts * 1000).toLocaleString() : "—";
}

interface EditState {
  id?: string; // present when editing
  flow_id: string;
  cron: string;
  environment: string | null;
  enabled: boolean;
}

export default function SchedulesPage() {
  const { message, modal } = AntApp.useApp();
  const flows = useStore((s) => s.flows);
  const envs = useStore((s) => s.envs);
  const openFlow = useStore((s) => s.openFlow);
  const setActiveFlow = useStore((s) => s.setActiveFlow);

  const [rows, setRows] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setRows(await api.listSchedules());
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Poll so "next run" / last-result stay fresh while the page is open.
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function openNew() {
    setEdit({
      flow_id: flows[0]?.id ?? "",
      cron: "0 9 * * *",
      environment: null,
      enabled: true,
    });
  }

  async function save() {
    if (!edit) return;
    if (!edit.flow_id) {
      message.error("pick a workflow");
      return;
    }
    setSaving(true);
    try {
      if (edit.id) {
        await api.updateSchedule(edit.id, {
          cron: edit.cron,
          environment: edit.environment,
          set_environment: true,
          enabled: edit.enabled,
        });
      } else {
        await api.createSchedule({
          flow_id: edit.flow_id,
          cron: edit.cron,
          environment: edit.environment,
          enabled: edit.enabled,
        });
      }
      setEdit(null);
      await load();
      message.success(edit.id ? "Schedule updated" : "Schedule created");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function toggle(s: Schedule, enabled: boolean) {
    try {
      await api.updateSchedule(s.id, { enabled });
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  async function runNow(s: Schedule) {
    try {
      const r = await api.runSchedule(s.id);
      if (r.status === "passed") message.success("Run passed");
      else if (r.status === "cancelled") message.warning("Run cancelled");
      else message.error(`Run ${r.status}${r.error ? ": " + r.error : ""}`);
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  function remove(s: Schedule) {
    modal.confirm({
      title: `Delete schedule for "${s.flow_name ?? s.flow_id}"?`,
      content: `Stops running "${s.cron}".`,
      okType: "danger",
      okText: "Delete",
      onOk: async () => {
        await api.deleteSchedule(s.id);
        load();
      },
    });
  }

  const columns = [
    {
      title: "Workflow",
      dataIndex: "flow_name",
      render: (name: string | null, r: Schedule) =>
        name ? (
          <a
            onClick={() => {
              openFlow(r.flow_id);
              setActiveFlow(r.flow_id);
            }}
          >
            {name}
          </a>
        ) : (
          <span style={{ opacity: 0.4 }}>(deleted)</span>
        ),
    },
    {
      title: "Schedule",
      dataIndex: "cron",
      render: (c: string) => <code style={{ fontSize: 12 }}>{c}</code>,
    },
    {
      title: "Env",
      dataIndex: "environment",
      render: (e: string | null) =>
        e ? <Tag>{e}</Tag> : <span style={{ opacity: 0.4 }}>—</span>,
    },
    {
      title: "Enabled",
      dataIndex: "enabled",
      render: (en: boolean, r: Schedule) => (
        <Switch
          size="small"
          checked={en}
          onChange={(v) => toggle(r, v)}
        />
      ),
    },
    {
      title: "Last run",
      key: "last",
      render: (_: unknown, r: Schedule) =>
        r.last_run_at ? (
          <Space size={6}>
            {r.last_status && (
              <Tag color={statusColor[r.last_status] || "default"}>
                {r.last_status}
              </Tag>
            )}
            <span style={{ fontSize: 12, opacity: 0.8 }}>
              {fmt(r.last_run_at)}
            </span>
          </Space>
        ) : (
          <span style={{ opacity: 0.4 }}>never</span>
        ),
    },
    {
      title: "Next run",
      dataIndex: "next_run_at",
      render: (t: number | null, r: Schedule) =>
        r.enabled ? (
          <span style={{ fontSize: 12 }}>{fmt(t)}</span>
        ) : (
          <span style={{ opacity: 0.4 }}>paused</span>
        ),
    },
    {
      title: "",
      key: "actions",
      render: (_: unknown, r: Schedule) => (
        <Space size={4}>
          <Tooltip title="Run now">
            <Button
              size="small"
              icon={<Play size={13} />}
              onClick={() => runNow(r)}
            />
          </Tooltip>
          <Button
            size="small"
            onClick={() =>
              setEdit({
                id: r.id,
                flow_id: r.flow_id,
                cron: r.cron,
                environment: r.environment,
                enabled: r.enabled,
              })
            }
          >
            Edit
          </Button>
          <Tooltip title="Delete">
            <Button
              size="small"
              danger
              icon={<Trash2 size={13} />}
              onClick={() => remove(r)}
            />
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div className="nbt-editor-pane">
      <Space style={{ marginBottom: 12 }}>
        <Clock size={16} />
        <strong style={{ fontSize: 16 }}>Schedules</strong>
        <Tag>{rows.length}</Tag>
        <Button size="small" icon={<RefreshCw size={14} />} onClick={load}>
          Refresh
        </Button>
        <Button
          size="small"
          type="primary"
          icon={<Plus size={14} />}
          disabled={flows.length === 0}
          onClick={openNew}
        >
          New schedule
        </Button>
      </Space>

      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No schedules yet. Create one to run a workflow on a cron cadence."
            />
          ),
        }}
      />

      <Modal
        title={edit?.id ? "Edit schedule" : "New schedule"}
        open={!!edit}
        onOk={save}
        confirmLoading={saving}
        onCancel={() => setEdit(null)}
        okText={edit?.id ? "Save" : "Create"}
      >
        {edit && (
          <Space direction="vertical" style={{ width: "100%" }} size={12}>
            <div>
              <div style={{ marginBottom: 4, fontSize: 13 }}>Workflow</div>
              <Select
                style={{ width: "100%" }}
                value={edit.flow_id || undefined}
                disabled={!!edit.id}
                placeholder="Select a workflow"
                showSearch
                optionFilterProp="label"
                options={flows.map((f) => ({ value: f.id, label: f.name }))}
                onChange={(v) => setEdit({ ...edit, flow_id: v })}
              />
            </div>
            <div>
              <div style={{ marginBottom: 4, fontSize: 13 }}>
                Cron expression{" "}
                <span style={{ opacity: 0.5 }}>
                  (minute hour day-of-month month day-of-week, server time)
                </span>
              </div>
              <Input
                value={edit.cron}
                onChange={(e) => setEdit({ ...edit, cron: e.target.value })}
                placeholder="0 9 * * 1-5"
                style={{ fontFamily: "monospace" }}
              />
              <Space wrap size={4} style={{ marginTop: 6 }}>
                {PRESETS.map(([label, cron]) => (
                  <Button
                    key={cron}
                    size="small"
                    type={edit.cron === cron ? "primary" : "default"}
                    onClick={() => setEdit({ ...edit, cron })}
                  >
                    {label}
                  </Button>
                ))}
              </Space>
            </div>
            <div>
              <div style={{ marginBottom: 4, fontSize: 13 }}>Environment</div>
              <Select
                style={{ width: "100%" }}
                allowClear
                placeholder="(no environment)"
                value={edit.environment ?? undefined}
                options={envs.map((e) => ({ value: e.name, label: e.name }))}
                onChange={(v) => setEdit({ ...edit, environment: v ?? null })}
              />
            </div>
            <Space>
              <Switch
                checked={edit.enabled}
                onChange={(v) => setEdit({ ...edit, enabled: v })}
              />
              <span>Enabled</span>
            </Space>
          </Space>
        )}
      </Modal>
    </div>
  );
}
