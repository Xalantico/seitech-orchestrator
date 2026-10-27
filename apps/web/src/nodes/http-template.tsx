import { getHandleId, Icon, type WorkflowNodeTemplateProps } from "@workflowbuilder/sdk";
import { Handle, Position } from "@xyflow/react";
import { memo, useMemo } from "react";

export const HttpRequestNodeTemplate = memo(function HttpRequestNodeTemplate({
  icon,
  label,
  description,
  selected = false,
  disabled = false,
  showHandles = true,
  layoutDirection,
}: WorkflowNodeTemplateProps) {
  const iconElement = useMemo(() => <Icon name={icon} size="large" />, [icon]);
  const isDown = layoutDirection !== "RIGHT";
  const targetId = getHandleId({ handleType: "target" });
  const sourceId = getHandleId({ handleType: "source" });
  const errorId = getHandleId({ handleType: "source", innerId: "errorRoute" });

  return (
    <div className={`poc-node ${selected ? "is-selected" : ""} ${disabled ? "is-disabled" : ""}`}>
      <div className="poc-node-header">
        <span className="poc-node-icon">{iconElement}</span>
        <div>
          <div className="poc-node-label">{label}</div>
          {description ? <div className="poc-node-desc">{description}</div> : null}
        </div>
      </div>
      {showHandles ? (
        <>
          <Handle
            id={targetId}
            type="target"
            position={isDown ? Position.Top : Position.Left}
          />
          <Handle
            id={sourceId}
            type="source"
            position={isDown ? Position.Bottom : Position.Right}
          />
          <Handle
            id={errorId}
            type="source"
            position={Position.Right}
            className="poc-error-handle"
          />
          <span className="poc-error-caption">error</span>
        </>
      ) : null}
    </div>
  );
});
