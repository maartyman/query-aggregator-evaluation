package main

import (
	"aggregator/auth"
	"fmt"
	"github.com/google/uuid"
	"github.com/sirupsen/logrus"
	"golang.org/x/net/context"
	v1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"net/http"
	"strings"
	"time"
)

var serverMux *http.ServeMux

func InitializeKubernetes(mux *http.ServeMux) {
	serverMux = mux
}

type Actor struct {
	Id                  string `json:"id"`
	PipelineDescription string `json:"pipelineDescription"`
	CreatedAt           time.Time
	Services            map[string]AggregatorService
	AuthorizationServer string
	OIDCToken           string
	etagServices        int
	pod                 *v1.Pod
}

func createLogicalActor() Actor {
	return Actor{Id: uuid.New().String(), CreatedAt: time.Now().UTC(), Services: make(map[string]AggregatorService)}
}

// TODO This needs to be more generic and extensible
func createActor(pipelineDescription string) (Actor, error) {
	id := uuid.New().String()
	fileLogs := getEnvBool("EXPERIMENT_SERVER_FILE_LOGS", false)

	container := v1.Container{
		Name:            "transformation",
		Image:           "incremunica",
		ImagePullPolicy: v1.PullNever,
		Env: []v1.EnvVar{
			{Name: "PIPELINE_DESCRIPTION", Value: fmt.Sprintf("%v", pipelineDescription)},
			{Name: "HTTP_PROXY", Value: "http://uma-proxy-service.default.svc.cluster.local:8080"},
			{Name: "HTTPS_PROXY", Value: "http://uma-proxy-service.default.svc.cluster.local:8443"},
			{Name: "SSL_CERT_FILE", Value: "/key-pair/uma-proxy.crt"},
			{Name: "LOG_LEVEL", Value: LogLevel.String()},
		},
		Ports: []v1.ContainerPort{
			{ContainerPort: 8080},
		},
		VolumeMounts: []v1.VolumeMount{
			{
				Name:      "key-pair",
				MountPath: "/key-pair",
				ReadOnly:  true,
			},
		},
	}
	volumes := []v1.Volume{
		{
			Name: "key-pair",
			VolumeSource: v1.VolumeSource{
				Secret: &v1.SecretVolumeSource{
					SecretName: "uma-proxy-key-pair",
				},
			},
		},
	}
	if fileLogs {
		container.Command = []string{"/bin/sh", "-c"}
		container.Args = []string{
			`set -u
mkdir -p /incremunica-logs
LOG_FILE="/incremunica-logs/incremunica-${HOSTNAME:-actor}-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
echo "Writing Incremunica output to ${LOG_FILE}"
npm run start >"${LOG_FILE}" 2>&1 &
app_pid=$!
tail -n +1 -f "${LOG_FILE}" &
tail_pid=$!
wait "${app_pid}"
status=$?
kill "${tail_pid}" 2>/dev/null || true
wait "${tail_pid}" 2>/dev/null || true
exit "${status}"`,
		}
		container.VolumeMounts = append(container.VolumeMounts, v1.VolumeMount{
			Name:      "incremunica-logs",
			MountPath: "/incremunica-logs",
		})
		volumes = append(volumes, v1.Volume{
			Name: "incremunica-logs",
			VolumeSource: v1.VolumeSource{
				HostPath: &v1.HostPathVolumeSource{
					Path: "/tmp/query-aggregator-evaluation/incremunica-logs",
					Type: hostPathTypePtr(v1.HostPathDirectoryOrCreate),
				},
			},
		})
	}

	podScafolding := &v1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: id,
			Labels: map[string]string{
				"app": id, // Important for service selector!
			},
		},
		Spec: v1.PodSpec{
			Containers:    []v1.Container{container},
			Volumes:       volumes,
			RestartPolicy: v1.RestartPolicyOnFailure,
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pod, err := Clientset.CoreV1().Pods("default").Create(ctx, podScafolding, metav1.CreateOptions{})
	if err != nil {
		return Actor{}, fmt.Errorf("failed to create pod: %v", err)
	}

	serviceName := "id-" + id + "-service"
	svc := &v1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name: serviceName,
		},
		Spec: v1.ServiceSpec{
			Type: v1.ServiceTypeNodePort, // Or NodePort if you want external access
			Selector: map[string]string{
				"app": id, // Matches pod's label
			},
			Ports: []v1.ServicePort{
				{
					Port:       80,                     // The port your client will use
					TargetPort: intstr.FromInt32(8080), // The port inside the pod
				},
			},
		},
	}

	_, err = Clientset.CoreV1().Services("default").Create(ctx, svc, metav1.CreateOptions{})
	if err != nil {
		return Actor{}, fmt.Errorf("failed to create service %s: %v", serviceName, err)
	}

	watcher, err := Clientset.CoreV1().Pods("default").Watch(context.Background(), metav1.ListOptions{
		FieldSelector: fmt.Sprintf("metadata.name=%s", id),
	})
	if err != nil {
		return Actor{}, fmt.Errorf("failed to watch pod %s: %v", id, err)
	}
	defer watcher.Stop()

	nodes, err := Clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		logrus.WithFields(logrus.Fields{"err": err}).Error("Failed to list nodes")
		return Actor{}, err
	}

	nodeIp := ""
	for _, node := range nodes.Items {
		for _, addr := range node.Status.Addresses {
			if addr.Type == v1.NodeExternalIP || addr.Type == v1.NodeInternalIP {
				nodeIp = addr.Address
				break
			}
		}
	}

	svc, err = Clientset.CoreV1().Services("default").Get(context.Background(), serviceName, metav1.GetOptions{})
	if err != nil {
		return Actor{}, err
	}

	nodePort := 0
	for _, port := range svc.Spec.Ports {
		if svc.Spec.Type == v1.ServiceTypeNodePort {
			nodePort = int(port.NodePort)
		}
	}

	if nodePort == 0 {
		return Actor{}, fmt.Errorf("no NodePort found for service %s", serviceName)
	}

	podReadyDeadline := time.After(120 * time.Second)
	for {
		select {
		case event, ok := <-watcher.ResultChan():
			if !ok {
				return Actor{}, fmt.Errorf("pod watch ended before pod %s became ready", id)
			}
			pod := event.Object.(*v1.Pod)
			if pod.Status.Phase == v1.PodFailed {
				return Actor{}, fmt.Errorf("pod failed to start: %v", pod.Status.Reason)
			}
			if isPodReady(pod) {
				goto podReady
			}
		case <-podReadyDeadline:
			return Actor{}, fmt.Errorf("pod %s did not become ready within 120s", id)
		}
	}

podReady:
	backendURL := fmt.Sprintf("http://%s:%d/", nodeIp, nodePort)
	if err := waitForBackendReachable(backendURL, 60*time.Second); err != nil {
		return Actor{}, fmt.Errorf("actor backend %s did not become reachable: %v", backendURL, err)
	}

	registerLegacyActorResource(id, nodeIp, nodePort, "/", []auth.ResourceScope{auth.ScopeRead})
	registerLegacyActorResource(id, nodeIp, nodePort, "/events", []auth.ResourceScope{auth.ScopeContinuousRead})

	logrus.WithFields(logrus.Fields{"url": backendURL}).Info("Pod backend is reachable")

	serverMux.HandleFunc("/"+id+"/", AuthProxyInstance.HandleAllRequests)

	serverMux.HandleFunc("/"+id, AuthProxyInstance.HandleAllRequests)

	actor := Actor{
		Id:                  id,
		PipelineDescription: pipelineDescription,
		CreatedAt:           time.Now().UTC(),
		Services:            make(map[string]AggregatorService),
		pod:                 pod,
	}

	return actor, nil
}

func hostPathTypePtr(hostPathType v1.HostPathType) *v1.HostPathType {
	return &hostPathType
}

func isPodReady(pod *v1.Pod) bool {
	if pod.Status.Phase != v1.PodRunning {
		return false
	}
	for _, condition := range pod.Status.Conditions {
		if condition.Type == v1.PodReady && condition.Status == v1.ConditionTrue {
			return true
		}
	}
	return false
}

func waitForBackendReachable(backendURL string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var lastErr error

	for time.Now().Before(deadline) {
		response, err := http.Get(backendURL)
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode < http.StatusInternalServerError {
				return nil
			}
			lastErr = fmt.Errorf("backend returned status %d", response.StatusCode)
		} else {
			lastErr = err
		}
		time.Sleep(500 * time.Millisecond)
	}

	if lastErr != nil {
		return lastErr
	}
	return fmt.Errorf("timed out")
}

func registerLegacyActorResource(actorID string, nodeIP string, nodePort int, endpoint string, scopes []auth.ResourceScope) {
	normalizedEndpoint := endpoint
	if normalizedEndpoint == "" {
		normalizedEndpoint = "/"
	}
	registeredResourcesMu.Lock()
	registeredResources[actorID+normalizedEndpoint] = &ResourceRegistration{
		PodName:     actorID,
		PodIP:       nodeIP,
		Port:        nodePort,
		Endpoint:    normalizedEndpoint,
		Scopes:      scopes,
		Description: "Legacy actor endpoint",
	}
	registeredResourcesMu.Unlock()

	resourceID := fmt.Sprintf("%s://%s:%s/%s%s", Protocol, Host, ServerPort, actorID, normalizedEndpoint)
	for _, scope := range scopes {
		if scope == auth.ScopeContinuousRead || scope == auth.ScopeContinuousWrite || scope == auth.ScopeContinuousDuplex {
			auth.AddStreamingResource(resourceID, scope)
		}
	}
	if err := auth.CreateResource(resourceID, scopes, nil); err != nil {
		logrus.WithFields(logrus.Fields{"actor_id": actorID, "endpoint": normalizedEndpoint, "err": err}).Debug("Failed to pre-register legacy actor resource with UMA")
	}
}

func (actor Actor) Stop() {
	if actor.pod != nil {
		// TODO stop service as well
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		err := Clientset.CoreV1().Pods("default").Delete(ctx, actor.pod.Name, metav1.DeleteOptions{})
		if err != nil {
			logrus.WithFields(logrus.Fields{"err": err, "actor_id": actor.Id}).Error("Error stopping actor")
		} else {
			logrus.WithFields(logrus.Fields{"actor_id": actor.Id}).Info("Actor stopped successfully")
		}
	}
}

func (actor Actor) marshalActor() string {
	pipelineForJson := strings.ReplaceAll(actor.PipelineDescription, `"`, `\"`)
	pipelineForJson = strings.ReplaceAll(pipelineForJson, "\n", `\n`)
	actorJson := fmt.Sprintf(
		`{"id":"%s","transformation":"%s"}`,
		actor.Id,
		pipelineForJson,
	)
	return actorJson
}
