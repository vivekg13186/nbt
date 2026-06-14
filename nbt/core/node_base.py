"""Base class interface for custom nodes.

To create a custom node, drop a .py file into the ``nodes/`` folder with a
subclass of :class:`BaseNode`:

    from nbt.core.node_base import BaseNode

    class MyNode(BaseNode):
        type_name = "my_node"          # unique key
        label = "My Node"              # shown in the editor
        category = "Custom"            # groups the Add Node menu
        inputs = {"url": "", "retries": 3, "verbose": False}  # name -> default
        outputs = ["result"]           # documented output keys

        def run(self, inputs, ctx):
            # Raise to fail the node. Return a dict of outputs.
            return {"result": inputs["url"].upper()}

        def check(self, outputs, inputs, ctx):
            # Optional class-level assert hook. Raise to fail the node.
            assert outputs["result"], "empty result"

The widget type per input is inferred from the default value's type
(bool -> checkbox, int/float -> number box, anything else -> text).
String inputs support ``{{ expression }}`` templating evaluated against the
execution context (outputs of previous nodes).
"""


class NodeError(Exception):
    """Raised by a node to signal failure of run()."""


class AssertionFailure(NodeError):
    """Raised when a node's assert (check hook or assert expression) fails."""


class BaseNode:
    """Class-style interface for pluggable test nodes."""

    type_name = "base"
    label = "Base Node"
    category = "General"
    inputs = {}      # dict: input name -> default value
    outputs = []     # list of output names produced by run()
    is_trigger = False

    def run(self, inputs: dict, ctx: dict) -> dict:
        """Execute the node. Return a dict of outputs. Raise to fail."""
        return {}

    def check(self, outputs: dict, inputs: dict, ctx: dict) -> None:
        """Optional assert hook, called after run(). Raise to fail the node."""
        return None


class TriggerNode(BaseNode):
    """Listener-style node: must be the START node of a flow.

    Instead of being executed, a trigger is *armed* via the Listen button.
    `start()` is called once; whenever the event you are watching for occurs,
    call `emit(outputs_dict)` — each emit runs the rest of the flow with the
    outputs available downstream (aliases work as usual). The trigger node's
    `pre` field acts as an event filter: falsy -> the event is ignored.

        class Every5Min(TriggerNode):
            type_name = "every_5_min"
            label = "Every 5 Minutes"
            inputs = {"seconds": 300.0}
            outputs = ["tick"]

            def start(self, emit, inputs, ctx):
                self._stop = threading.Event()
                def loop():
                    n = 0
                    while not self._stop.wait(float(inputs["seconds"])):
                        n += 1
                        emit({"tick": n})
                threading.Thread(target=loop, daemon=True).start()

            def stop(self):
                self._stop.set()
    """

    is_trigger = True

    def start(self, emit, inputs: dict, ctx: dict) -> None:
        """Arm the trigger. Call emit(dict) whenever the event fires.
        Must not block: do the watching on your own daemon thread."""
        raise NotImplementedError

    def stop(self) -> None:
        """Disarm the trigger; stop threads/watchers started in start()."""
        return None
